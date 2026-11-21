# Claude Agent SDK backend

`backend.type: "claude"` runs each turn in Claude Code through the
[Claude Agent SDK][sdk]. `package.json` pins `@anthropic-ai/claude-agent-sdk`
to one exact version, and a test keeps it exact. The SDK package includes its
own Claude Code CLI (its `claudeCodeVersion`) as a native binary for each
platform. Stargate uses that binary, not a `claude` command on `PATH`.

Use it for a Slack bot, an IRC captain or an IRC crew member, beside
`opencode`, `pi-durable` and `module` backends. Crew members of the OpenCode
crew plugin (`stargate crew init` team JSON) still use OpenCode or Pi Durable;
see [limits](#limits).

## Set up through CLIProxyAPI

The model is reached only through an explicit proxy `provider`. There is no
fallback to the host's Claude login, `ANTHROPIC_API_KEY` or another provider.

1. Install and sign in to the separate proxy as described in
   [CLIProxyAPI for Stargate](cliproxyapi.md), including `--claude-login`.
2. Confirm that authenticated model discovery lists the model you want, for
   example `claude-opus-5-5`, `claude-sonnet-5-5` or `claude-haiku-5-5`.
   Discovery is not an inference test.
3. Put the proxy client key in an environment variable of the Stargate process,
   for example `CLIPROXYAPI_API_KEY` in the private `<config>.env` companion
   or the service environment. Never put the key in JSON.
4. Add the backend, run `stargate config check`, then restart Stargate. Backend
   changes are restart-only.
5. Get consent for real model requests, then test one Slack mention and a
   same-thread follow-up.

A Slack bot:

```json
"backend": {
  "type": "claude",
  "directory": "/srv/stargate/claude-helper",
  "model": "claude-sonnet-5-5",
  "provider": {
    "baseURL": "http://127.0.0.1:8317/v1",
    "apiKeyEnv": "CLIPROXYAPI_API_KEY"
  },
  "systemPrompt": "You answer in Slack. Keep replies short."
}
```

A Galactica IRC crew member on Claude Opus with read-only tools (add it to
the `irc[].crew` array; see [IRC transport](irc.md#crew-on-irc)):

```json
{
  "id": "helo",
  "account": "galactica-helo",
  "passwordEnv": "STARGATE_IRC_GALACTICA_HELO_PASSWORD",
  "channels": ["#ship-galactica"],
  "backend": {
    "type": "claude",
    "directory": "/srv/galactica/crew/helo",
    "model": "claude-opus-5-5",
    "provider": {
      "baseURL": "http://127.0.0.1:8317/v1",
      "apiKeyEnv": "CLIPROXYAPI_API_KEY"
    },
    "effort": "high",
    "systemPrompt": "You are Helo, a Galactica crew member. Report verified facts with file paths. Do not change files.",
    "allowedTools": ["Read", "Grep", "Glob"]
  }
}
```

## Fields

| Field            | Rule                                                                            |
| ---------------- | ------------------------------------------------------------------------------- |
| `directory`      | Absolute starting working directory. It is **not a sandbox**                    |
| `model`          | Model ID that the proxy publishes, such as `claude-opus-5-5`                    |
| `provider`       | Required. `baseURL` (HTTPS, or loopback HTTP, ending `/v1`) and `apiKeyEnv`     |
| `effort`         | Optional `low`, `medium`, `high`, `xhigh` or `max`; unset keeps the CLI default |
| `systemPrompt`   | Optional text appended to Claude Code's own system prompt                       |
| `allowedTools`   | Bare built-in tool names; default `[]` (no built-in tools)                      |
| `mcpServers`     | Optional trusted HTTP and stdio MCP servers; default absent                     |
| `settingSources` | `project` and/or `local`; default `[]` (no settings files, no CLAUDE.md)        |
| `maxTurns`       | Model round trips per turn, 1–500; default 50                                   |

Unknown fields are refused. `bypassPermissions`, `auto`, plugins and custom
environment variables are not configurable. A change to any
backend field selects a new session namespace, as for other backends.

`baseURL` uses the same `/v1` endpoint as the OpenCode `claude-proxy`
provider and Pi Durable. Stargate removes `/v1` and passes the root to Claude
Code as `ANTHROPIC_BASE_URL`. The key travels as a bearer token
(`ANTHROPIC_AUTH_TOKEN`), the method that CLIProxyAPI documents for Claude
Code. Native Anthropic API keys (`x-api-key`) and Claude subscription logins
are not supported by this backend.

## Tools and permissions

With the defaults the model has **no tools**. Stargate always starts Claude Code
in `dontAsk` permission mode with no permission prompts: a tool call that no
allow rule permits is denied, never asked. Approval buttons do not exist.

`allowedTools` names the only built-in tools that the model can see (the SDK `tools`
option) and permits every call to them (the SDK `allowedTools` option). Any
other built-in tool is absent. Scoped rules such as
`Read(./src/**)` or `Bash(git status:*)` are refused: Claude Code permits
reads anywhere in its working directory whatever the scope says, so a scope
would promise a limit that nothing enforces. There is no deny list; leave a
tool out instead.

Stargate accepts these tools: `Agent`, `Bash`, `Edit`, `Glob`, `Grep`, `LSP`,
`NotebookEdit`, `Read`, `TodoWrite`, `WebFetch`, `WebSearch` and `Write`.
Scheduling, notification, plan-mode, worktree and question tools are refused.
`WebSearch` needs a proxy route that supports the server-side search tool.

`directory` is only where Claude Code starts. With `Read`, `Bash` or `Edit`
the agent can reach every file and command that the Stargate OS account can,
including the real home directory. `Bash` permits every command. Use a
separate OS account or container for an untrusted audience. Do not enable
tools for people who should not run code as Stargate.

## MCP servers

For a bot that needs an existing integration, explicitly list its servers in
`backend.mcpServers`. The configured servers are available on the first turn.
Leave `allowedTools` empty if no built-in tools are needed.
Replace these example URLs, commands and arguments with your own servers.

```json
"allowedTools": [],
"mcpServers": {
  "docs": {
    "type": "http",
    "url": "https://mcp.example.org/docs",
    "headersHelper": "/usr/local/bin/docs-mcp-headers"
  },
  "search": {
    "type": "stdio",
    "command": "/usr/local/bin/project-search-mcp",
    "args": ["--read-only"]
  }
}
```

Server names use lowercase letters, digits, underscores or hyphens and start
with a letter. HTTP URLs require HTTPS or loopback HTTP, with no credentials,
query or fragment. An optional `headersHelper` is an absolute executable
followed by literal arguments. Claude Code runs it to obtain a JSON object
of headers. Use an existing credential helper and keep credentials out of
configuration and arguments. Stdio servers start an absolute executable with
an optional list of arguments.

Configuring a server permits all the MCP tools it exposes. Use trusted
servers for the audience authorised to use the bot. A local server or
credential helper runs as Stargate's OS account, with its filesystem and network
access. Neither `allowedTools: []` nor the working directory confines those
programs. Only the explicitly configured servers are loaded from bot
configuration.

Stargate sends MCP configuration over stdin with the SDK's
`mcpServersDelivery: "initialize"`. Before each turn it checks the executable's
`--version` against the installed SDK's `claudeCodeVersion`. An equal or newer
CLI uses stdin. A known older CLI uses explicit `"argv"` delivery and emits
`STARGATE_CLAUDE_MCP_ARGV_FALLBACK`; MCP environment values and headers can then
be visible to other local users. Update that CLI to remove this exposure.
Missing, unrecognised or prerelease versions, failed probes and probes that
exceed five seconds stop the turn before the SDK starts. Probe diagnostics
are discarded, and the probe receives no provider token.

## Settings, memory and prompts

`settingSources` is empty by default: Claude Code reads no
`.claude/settings*.json`, no `CLAUDE.md` and no `AGENTS.md` from `directory`.
`project` loads `.claude/settings.json` and `CLAUDE.md`; `local` loads
`.claude/settings.local.json`. Host user settings in `~/.claude` are never
loaded. Managed (administrator) settings of the host still apply.

Stargate passes its routing variables (endpoint, model aliases, no HTTP proxy,
no optional traffic) and `disableAllHooks: true` as flag settings. These
override project and local settings, so a settings file cannot redirect the
endpoint and its key, select another model or run hooks. Settings files can
still run commands through `apiKeyHelper` and similar helper settings, set
environment variables for tool commands, and add instructions. Load them
only from a directory that you trust as code. Do not combine them with
`Edit` or `Write` on `.claude/` for an untrusted audience.

Chat text is sent verbatim: Claude Code does not expand `@file` mentions or
run slash commands such as `/clear` from a message. Pinned-captain source
lines are not used by this backend; unpinned turns get the transport note
like Pi Durable.

## Environment and credentials

The Claude Code child gets a new, minimal environment. It inherits only
`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `LC_CTYPE` and
`TZ`. Stargate then sets:

- `TMPDIR`: a new private directory for each turn under Stargate's temporary
  directory, removed after the CLI exits.
- `CLAUDE_CONFIG_DIR`: a private directory for this backend namespace,
  `<dataDirectory>/<bot>/<namespace>/claude` (mode `0700`). Claude Code keeps
  its sessions, settings and caches there. The host's `~/.claude` and
  `~/.claude.json`, including any login, are not used.
- `ANTHROPIC_AUTH_TOKEN`: the value of `apiKeyEnv`, only in the environment,
  never in arguments.
- `ANTHROPIC_BASE_URL`: `baseURL` without `/v1`.
- `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`,
  `ANTHROPIC_DEFAULT_HAIKU_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL`, all set
  to `model`, so background and subagent requests never select a model that
  the proxy does not publish.
- `NO_PROXY=*`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and
  `DISABLE_AUTOUPDATER=1`: no HTTP proxy, telemetry, error reports or
  update checks.
- `CLAUDE_AGENT_SDK_CLIENT_APP=stargate`.

Every other variable, such as Slack tokens, `ANTHROPIC_API_KEY`,
`CLAUDE_CODE_OAUTH_TOKEN`, other provider keys, `HTTPS_PROXY` and
`NODE_OPTIONS`, is dropped. Claude Code diagnostics on stderr are discarded,
because they can contain request details. Stargate logs only fixed failure
causes. The key variable must be present when Stargate starts; startup fails
otherwise.

## Sessions

A new conversation gets a random UUID. Its first turn creates the Claude Code
session with that ID (`--session-id`); later turns resume it (`--resume`).
Transcripts stay in the namespace's private `CLAUDE_CONFIG_DIR`, so a
session survives a Stargate restart. A backend-setting change selects a new
namespace with its own directory; Stargate never resumes another namespace's or
another backend's session. One conversation runs one turn at a time.

Each turn starts one Claude Code process and ends it after the result. Stargate
streams visible assistant text to the live reply. Thinking, tool input and
tool results are not shown. The reply is the main agent's text of this turn;
subagent text is not included.

Images (PNG, JPEG, GIF, WebP), PDF files and UTF-8 text files become model
input. Other files fail the turn before Claude Code starts, with the normal
attachment notice.

## Cancellation and recovery

Stop, the turn time limit and shutdown send `SIGTERM` to the Claude Code
process group. The turn then fails with the normal notice. Tool effects are
not undone.

No process of a turn outlives it. Claude Code runs Bash commands in their own
sessions, outside its process group, so every process of a turn inherits a
random `STARGATE_CLAUDE_TURN` value. A CLI that has not exited five seconds after
its result or after `SIGTERM` gets `SIGTERM`, then `SIGKILL`, with its
process group; Stargate signals that group only while the CLI is its own
unreaped child, so the group ID cannot have been reused. After the CLI has
exited, every process that carries the value gets `SIGTERM`, and whatever
remains after five more seconds gets `SIGKILL`. Background tasks therefore
end with their turn; the turn keeps its result.

Stargate finds these processes through `/proc` (Linux only). A process counts
only when all four of its user IDs are Stargate's, it started no earlier than
the CLI, and its environment carries the turn value. Stargate reads the
environment only of such processes. Each candidate is identified by its PID
and start time (`/proc/<pid>/stat` field 22). Immediately before each
signal, Stargate reads the start time, user IDs and marker again and signals
only if all still match. Bun and Node have no pidfd API, so this check and
`kill` run synchronously, without yielding to other work: a PID could be
reused only if its process exited and the kernel gave the same number to a
new process within that sub-millisecond window. A command that deliberately
clears its environment or changes user escapes this clean-up; it is a guard
against leftovers, not a sandbox.

Stargate records each running CLI (process ID, turn value and start time) in
`<dataDirectory>/<bot>/<namespace>/claude-runs/`. If Stargate stops abruptly, the
CLI can continue until its turn ends. On restart, recovery and the next turn
of that conversation stop what the record names. The CLI's group is
signalled only while its leader still matches the record: the same start
time, Stargate's user, the turn value, the session ID in `/proc/<pid>/cmdline`,
and still the group leader. While that leader lives, its group ID cannot be
reused. Other processes are signalled only with the identity check above. On
systems without `/proc` an orphaned CLI runs until it finishes. systemd's
default `KillMode` also stops these processes when the service stops.

## Limits

- No dashboard session history, transcript catch-up or `watch`. Only the
  turn's own reply is delivered. Claude Code background work ends with the
  turn, at most five seconds after its result.
- No pinned shared captain session (`sessionID`), crew status, quota, pairing,
  crew activity reports or maintenance notices.
- Not available as an OpenCode crew-plugin member (`team.json` `backend`).
  Those members use OpenCode or Pi Durable. Use an IRC crew registration for
  a Claude crew member.
- No plugins, sandbox settings, hooks or interactive approvals.
- One Claude Code process per turn. Its start-up time adds to each turn.
- Nightly maintenance model updates do not change `claude` backends; edit
  `model` and restart (this selects a new session namespace).
- Process clean-up beyond the CLI's group and orphan recovery are
  Linux-only and best effort.
- The SDK package installs a native CLI binary of about 350 MB for the host
  platform. Dependabot updates the exact pin; review CLI behaviour changes
  before merging.

## Tests

`tests/claude-backend.test.ts` drives the real SDK against a fake CLI
(`tests/claude-fixture.ts`). `tests/claude-cli.test.ts` runs the pinned real
Claude Code CLI against a loopback Messages fixture with canary credentials
in a fake home directory. No test contacts a provider.

[sdk]: https://platform.claude.com/docs/en/agent-sdk/overview

With IRC live progress enabled, Claude reports the main turn's model, reasoning, tool
and reply stages as its SDK emits them. IRC receives fixed stage descriptions
and timestamps. Native clarification recovery is available on OpenCode.
