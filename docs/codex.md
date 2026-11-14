# Codex SDK backend

`backend.type: "codex"` runs each turn in the Codex CLI through the
[Codex SDK][sdk]. `package.json` pins `@openai/codex-sdk` to one exact
version, and a test keeps it exact. The SDK depends on `@openai/codex` of the
same version, which installs the native Codex CLI for the host platform,
with its bundled `bwrap` sandbox helper and `rg`. Pogo uses that binary, not
a `codex` command on `PATH`. A test checks that Pogo resolves the same binary
and helper directory as the SDK.

Use it for a Slack bot, an IRC captain or an IRC crew member, beside
`opencode`, `pi-durable`, `claude` and `module` backends. Crew members of the
OpenCode crew plugin (`pogo crew init` team JSON) still use OpenCode or Pi
Durable; see [limits](#limits).

## Set up through CLIProxyAPI

The model is reached only through an explicit proxy `provider`, an OpenAI
Responses API endpoint. There is no fallback to the host's Codex or ChatGPT
login, `~/.codex`, `OPENAI_API_KEY`, `CODEX_API_KEY` or another provider.

1. Install and sign in to the separate proxy as described in
   [CLIProxyAPI for Pogo](cliproxyapi.md), including the Codex login.
2. Confirm that authenticated model discovery lists the model you want, for
   example `gpt-6.1-sol`, `gpt-6.1-terra` or `gpt-6-luna`: the models of the
   OpenCode `openai-proxy` provider. Discovery is not an inference test.
3. Put the proxy client key in an environment variable of the Pogo process,
   for example `CLIPROXYAPI_API_KEY` in the private `<config>.env` companion
   or the service environment. Never put the key in JSON. A separate client
   key for each Codex backend limits what one leaked key can do (see
   [sandbox](#sandbox-and-network)).
4. Add the backend, run `pogo config check`, then restart Pogo. Backend
   changes are restart-only.
5. Get consent for real model requests, then test one mention and a
   same-thread follow-up. Also run one tool command (for example "list the
   files in your directory") to confirm that the sandbox starts on the host.

A Slack bot:

```json
"backend": {
  "type": "codex",
  "directory": "/srv/pogo/codex-helper",
  "model": "gpt-6.1-sol",
  "provider": {
    "baseURL": "http://127.0.0.1:8317/v1",
    "apiKeyEnv": "CLIPROXYAPI_API_KEY"
  },
  "systemPrompt": "You answer in Slack. Keep replies short."
}
```

A Galactica IRC crew member on GPT-6.1 Terra that can change files in its own
worktree (add it to the `irc[].crew` array of the `galactica-irc`
registration; see [IRC transport](irc.md#crew-on-irc)). The ship channel is
`#ship-galactica` and crew accounts follow `galactica-<crew>`:

```json
{
  "id": "athena",
  "account": "galactica-athena",
  "passwordEnv": "POGO_IRC_GALACTICA_ATHENA_PASSWORD",
  "channels": ["#ship-galactica"],
  "backend": {
    "type": "codex",
    "directory": "/srv/galactica/crew/athena",
    "model": "gpt-6.1-terra",
    "provider": {
      "baseURL": "http://127.0.0.1:8317/v1",
      "apiKeyEnv": "POGO_CODEX_ATHENA_PROXY_KEY"
    },
    "reasoningEffort": "high",
    "sandbox": "workspace-write",
    "systemPrompt": "You are Athena, a Galactica crew member. Work only in your directory. Report verified facts with file paths."
  }
}
```

The captain itself can also use Codex. The `galactica-irc` registration's
`backend` is then a `codex` backend with the captain's `directory` and
`systemPrompt`; captains on Codex are unpinned (no `sessionID`).

## Fields

| Field             | Rule                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `directory`       | Absolute starting working directory and sandbox root                                     |
| `model`           | Model ID that the proxy publishes, such as `gpt-6.1-sol`                                 |
| `provider`        | Required. `baseURL` (HTTPS, or loopback HTTP, ending `/v1`) and `apiKeyEnv`              |
| `reasoningEffort` | Optional `minimal`, `low`, `medium`, `high` or `xhigh`; unset keeps the model default    |
| `systemPrompt`    | Optional text, sent as Codex developer instructions                                      |
| `sandbox`         | `read-only` (default), `workspace-write` or `danger-full-access`                         |
| `network`         | Tool network access; default `false`. See [sandbox](#sandbox-and-network)                |
| `projectDocs`     | Read `AGENTS.md` project instructions from `directory`; default `false`                  |
| `extraPath`       | Absolute directories after the system ones on the CLI's `PATH`; default `[]`, at most 32 |

Unknown fields are refused. Approval policies, web search, MCP servers,
Codex profiles, configuration overrides and custom environment variables are
not configurable. A change to any backend field selects a new session
namespace, as for other backends.

`baseURL` is the same `/v1` endpoint as the OpenCode `openai-proxy` provider.
Pogo defines it as the only Codex model provider (`model_provider = "pogo"`,
`wire_api = "responses"`) through `--config` overrides. Command-line
overrides are above every user and project configuration layer, so no
`config.toml` can redirect the endpoint or the key. The key travels as a
bearer token. ChatGPT logins and native OpenAI API keys are not supported by
this backend.

## Sandbox and network

Codex runs tool commands (shell commands, `apply_patch`) in its own sandbox.
Pogo always starts Codex with approval policy `never`: a request to run a
command outside the sandbox is refused, never asked. Approval buttons do not
exist. Web search is always off.

| `sandbox`            | Files                                                      | Tool network                         |
| -------------------- | ---------------------------------------------------------- | ------------------------------------ |
| `read-only`          | Read everything the Pogo account can; write nothing        | Always blocked                       |
| `workspace-write`    | Also write inside `directory` and the turn's temporary dir | Blocked unless `network: true`       |
| `danger-full-access` | No sandbox: every file and command of the Pogo OS account  | Not blockable; needs `network: true` |

Configuration refuses `network: true` with `read-only` (that sandbox always
blocks network) and refuses `danger-full-access` without `network: true`,
so the configuration never promises a limit that Codex does not enforce.
`workspace-write` never makes the shared `/tmp` writable
(`sandbox_workspace_write.exclude_slash_tmp`); the turn's `TMPDIR` is.

On Linux the sandbox uses the bundled bubblewrap with a private PID
namespace and a read-only view of the file system, and blocks network
sockets.
It needs unprivileged user namespaces. On hosts that restrict them (for
example Ubuntu 24.04 with the AppArmor user-namespace restriction) tool
commands fail; the model then sees the failure. Run one tool turn after
setup to check the host.

The sandbox limits writes and network, not reads: a `read-only` agent can
read every file that the Pogo OS account can read, including the real home
directory. Use a separate OS account or container for an untrusted audience.

### What runs outside the sandbox

Pogo's launcher, the Codex CLI and the commands that the CLI runs itself
(for example `git` in a repository) run outside the sandbox, with the proxy
key in their environment. Nothing that they run or read may be writable from
inside the sandbox. With `sandbox: "workspace-write"`, Pogo therefore
refuses a `directory` that contains, or lies inside, Pogo's data directory
(the launcher, `CODEX_HOME`, `ZDOTDIR` and thread maps), Pogo's
installation, or the Codex SDK and CLI packages, and a `directory` that
contains the home directory (start-up files such as `~/.gitconfig`). A
`directory` inside the home directory is fine. Paths are compared after
symbolic links are resolved. `pogo config check` reports this for the
configured data directory; backend start-up and every turn check it again,
and a turn fails before the CLI starts. Inside `directory`, Codex itself
keeps `.git` and `.codex` read-only. The turn's `TMPDIR` is new for each
turn and holds nothing of Pogo's.

After these checks Pogo uses only the canonical form of each path (all
symbolic links resolved) for everything it writes, checks or runs: the
workspace, the data directory and its subdirectories, the launcher, the
CLI, the helper directory, the turn's `TMPDIR` and every `PATH` entry. A
symbolic link on such a path is refused when its directory is writable by
Pogo's user or lies inside a writable root, because it could be retargeted
after the check. Links that only root controls, such as `/bin` →
`/usr/bin`, are resolved and accepted.

The launcher is written for each turn as `<…>/codex-bin/<turn>.sh` (mode
0700, in a 0700 directory) with `O_EXCL | O_NOFOLLOW`, after checking that no
component of its path is a symbolic link. It is checked again for exactly
its expected content, owner and mode immediately before the turn, run by
that canonical path, and removed after it. It never looks
commands up through `PATH`: it runs `sh`, `mkfifo`, `cat` and `rm` by
absolute path from `/usr/bin` or `/bin`, and only when root owns each path
and the file it resolves to, with no group- or world-writable directory on
the way. It uses the canonical path, except when that has another name
(`/usr/bin/rm` → `gnurm`): programs such as busybox select their command by
name, so the root-controlled path as written is kept. It runs the native
CLI by its canonical path.

The operator's `PATH` is never passed on. The CLI and its tool commands
get a fixed `PATH` that Pogo builds at start-up:

1. the SDK's helper directory (with `rg`), in canonical form;
2. `/usr/local/bin`, `/usr/bin` and `/bin`, in canonical form and without
   duplicates, each only when root controls the directory and every
   program in it over the full link chain (every directory and link on the
   way and the file itself owned by root, none group- or world-writable).
   One program that fails leaves out its whole directory;
3. the backend's `extraPath` entries, in order.

Start-up fails when no system directory qualifies and `extraPath` is
empty, because tool commands could then run nothing. The error names each
directory and why it was left out, for example
`/usr/bin: node in it is not root-controlled`. GitHub's hosted Ubuntu runners are
such hosts: no system directory qualifies there.
Make root own those programs, or list directories that you trust in
`extraPath`. The CLI also finds `bwrap` through this `PATH` and otherwise
uses its bundled copy, which may not start where the system one does.

`extraPath` is trusted operator input for user-installed programs, such as
`["/home/pogo/.local/bin"]`. Start-up fails when an entry is reached
through a symbolic link that Pogo's user or the sandbox can change, is not
an existing directory, lies inside `directory`, or holds a program whose
link chain passes through a link inside `directory` or that runs from
inside it. Programs added to an `extraPath` directory later are not
checked, and a hard link to a workspace file there is not detected. Tools
that need user-installed programs therefore need either a root-owned
system directory or an explicit `extraPath` entry. A command that the
agent plants in the workspace never runs outside the sandbox, for example
as the CLI's `git`.

Inside a sandbox, tool commands cannot read the Codex process's environment
and therefore not the proxy key (the key variable is also removed from tool
environments). With `danger-full-access` a tool command can read the CLI's
`/proc/<pid>/environ` and so the proxy key. Give such a backend its own proxy
client key, which you can revoke on its own.

## Instructions, skills and configuration

Pogo passes these settings as `--config` overrides on every turn:

- No `AGENTS.md` project instructions (`project_doc_max_bytes = 0`) unless
  `projectDocs` is `true`.
- No skills (`skills.include_instructions = false`): neither the system
  skills that Codex installs in `CODEX_HOME` nor `~/.agents/skills`.
- No subagents (`agents.enabled = false`), and the features `plugins`,
  `remote_plugin`, `apps`, `hooks`, `memories`, `goals`, `tool_suggest`,
  `image_generation` and `multi_agent` off.
- No shell snapshot (`features.shell_snapshot = false`), so Codex does not
  run the account's login shell start-up files, and no login shells for
  commands (`allow_login_shell = false`).
- No analytics, feedback upload, update check or prompt history
  (`analytics.enabled = false`, `feedback.enabled = false`,
  `check_for_update_on_startup = false`, `history.persistence = "none"`).
- The key variable is excluded from tool command environments
  (`shell_environment_policy.exclude`).

`CODEX_HOME` is a private directory of the backend namespace, so the host's
`~/.codex` (login, `config.toml`, profiles, MCP servers, hooks, rules) is
never read. A project `.codex/config.toml` in `directory` is not loaded,
because the project is not marked as trusted in that private home. Managed
(administrator) configuration of the host still applies.

The model sees the remaining Codex tools: `exec` (JavaScript that calls
`exec_command`, `write_stdin`, `apply_patch`, `view_image`, `clock__curr_time`
and MCP resource readers, which have no servers to read), `wait`,
`request_user_input` and `clock.sleep`. A real-CLI test keeps this set
exact.

Chat text is sent verbatim. Pinned-captain source lines are not used by this
backend; unpinned turns get the transport note like Pi Durable.

## Environment and credentials

The Codex CLI gets a new, minimal environment. It inherits only `HOME`,
`USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `LC_CTYPE` and `TZ`.
Pogo then sets:

- `PATH`: fixed at start-up: the SDK's helper directory, root-owned system
  directories and `extraPath`; the inherited value is replaced
  ([details](#what-runs-outside-the-sandbox)).
- `TMPDIR`: a new private directory for each turn under Pogo's temporary
  directory, removed after the turn. Image attachments are written there.
- `CODEX_HOME`: a private directory for this backend namespace,
  `<dataDirectory>/<bot>/<namespace>/codex` (mode `0700`). Codex keeps its
  threads, state databases and caches there.
- `ZDOTDIR`: an empty private directory, `<…>/codex-shell`. Codex runs
  commands with the account's login shell from the password database,
  whatever `SHELL` says, and zsh reads `$ZDOTDIR/.zshenv` even when not
  interactive. The host's `~/.zshenv` therefore does not run. System files
  such as `/etc/zsh/zshenv` still run; other shells' non-interactive
  start-up files (for example fish's `config.fish`) are not controlled.
- `POGO_CODEX_PROVIDER_KEY`: the value of `apiKeyEnv`, only in the
  environment, never in arguments.
- `POGO_CODEX_TURN`: the turn marker; see [cancellation](#cancellation-and-recovery).
- `NO_PROXY=*`: no HTTP proxy.

Every other variable, such as Slack tokens, `OPENAI_API_KEY`,
`CODEX_API_KEY`, `OPENAI_BASE_URL`, other provider keys, `HTTPS_PROXY` and
`NODE_OPTIONS`, is dropped. Codex errors contain the CLI's stderr, which can
contain request details; Pogo never forwards them and logs only fixed
failure causes. The key variable must be present when Pogo starts; startup
fails otherwise.

## Sessions

A new conversation gets a random Pogo UUID. Its first turn starts a Codex
thread; Pogo stores the thread ID that Codex reports in
`<…>/codex-threads/<conversation>.json` before the turn continues. Later
turns resume that thread (`codex exec resume`), also after a Pogo restart.
A turn that reports another thread ID fails without changing the mapping. A
backend-setting change selects a new namespace with its own `CODEX_HOME`;
Pogo never resumes another namespace's or another backend's thread. One
conversation runs one turn at a time.

Each turn starts one Codex process, which exits after the turn. Pogo streams
the turn's completed agent messages to the live reply. Reasoning, commands,
command output, file changes and error items are not shown. The reply is the
agent messages of this turn, joined by blank lines. Codex reports a message
only when it is complete, so the preview grows by whole messages.

Images (PNG, JPEG, GIF, WebP) are passed to Codex as image inputs, and UTF-8
text files are added to the prompt. PDF and other files fail the turn before
Codex starts, with the normal attachment notice.

## Cancellation and recovery

Stop, the turn time limit and shutdown abort the SDK's stream, which sends
`SIGTERM` to the Codex CLI. The turn then fails with the normal notice. Tool
effects are not undone. A CLI that has not exited five seconds after its
result is stopped the same way; the turn keeps its result.

No process of a turn outlives it. The Codex CLI runs in Pogo's own process
group, and its sandbox helpers and commands run in new sessions and PID
namespaces, so there is no group to signal. Instead every process of a turn
inherits a random `POGO_CODEX_TURN` value. Every process that carries the
value gets `SIGTERM`, and whatever remains after five seconds gets
`SIGKILL`. This includes the CLI itself, the sandbox helper and commands
that ignore `SIGTERM`.

This clean-up starts when the turn is cancelled, without waiting for the
CLI's output to end: the SDK sends only `SIGTERM` and then waits for that
output, which a CLI that ignores `SIGTERM` never closes. A cancelled turn,
`interrupt` and shutdown therefore settle within about six seconds. After a
turn ends by itself, the same clean-up stops what it left.

The SDK exposes neither the CLI process nor its output stream, and a process
that the CLI starts can inherit that output and keep it open. Pogo therefore
starts the CLI through its own launcher (`<…>/codex-bin/<turn>.sh`, the SDK's
`codexPathOverride`), a short `sh` script. It `exec`s the CLI, so the CLI
stays the SDK's child with unchanged signals and exit status, but sends the
CLI's output through a FIFO to `cat`. The FIFO is unlinked as soon as both
ends are open. Only `cat` then holds Pogo's output and error pipes, and it
carries the turn marker, so the clean-up closes them even while a process
without the marker keeps the CLI's own output open. The CLI's stderr goes to
`/dev/null`; Pogo never uses it. If the output is still open one second
after the clean-up (only possible without `/proc`), the turn stops waiting
for it.

Pogo finds these processes through `/proc` (Linux only), with the same
checks as the [Claude backend](claude.md#cancellation-and-recovery): all
four user IDs are Pogo's, the process started no earlier than the turn, and
its environment carries the turn value. Immediately before each signal, Pogo
reads the start time, user IDs and marker again and signals only if all
still match. A command that deliberately clears its environment or changes
user escapes this clean-up; it is a guard against leftovers, not a sandbox.

Pogo records each running turn (turn value and start time, no process ID) in
`<…>/codex-runs/`. If Pogo stops abruptly, the CLI can continue until its
turn ends. On restart, recovery and the next turn of that conversation stop
the processes that carry the recorded value, with the checks above. On
systems without `/proc` an orphaned CLI runs until it finishes. systemd's
default `KillMode` also stops these processes when the service stops.

## Limits

- No dashboard session history, transcript catch-up or `watch`. Only the
  turn's own reply is delivered.
- No pinned shared captain session (`sessionID`), crew status, quota,
  pairing, crew activity reports or maintenance notices.
- Not available as an OpenCode crew-plugin member (`team.json` `backend`).
  Use an IRC crew registration for a Codex crew member.
- No MCP servers, plugins, skills, hooks, web search or interactive
  approvals. `request_user_input` cannot reach a person.
- One Codex process per turn. Its start-up time adds to each turn.
- Nightly maintenance model updates do not change `codex` backends; edit
  `model` and restart (this selects a new session namespace).
- Process clean-up and orphan recovery are Linux-only and best effort.
  Without `/proc`, a cancelled turn still settles, but a CLI that ignores
  `SIGTERM` can keep running, and so can its output pipe.
- The launcher needs root-owned `sh`, `mkfifo`, `cat` and `rm` in `/usr/bin`
  or `/bin`. Hosts without them there, such as NixOS, cannot start a Codex
  backend.
- With `workspace-write`, a workspace, data directory or CLI path that
  passes through a symbolic link in a directory that Pogo's user can write
  is refused; use the real path.
- The CLI does not see the operator's `PATH`. Programs outside root-owned
  system directories need an `extraPath` entry. A host where no system
  directory qualifies, such as a hosted CI runner, needs `extraPath` to
  start a Codex backend.
- `workspace-write` refuses a `directory` that contains Pogo's data
  directory or installation, or the home directory. Move Pogo's
  `dataDirectory` out of the workspace (its default `.pogo` is next to the
  configuration file).
- Other files outside the sandbox that unsandboxed commands read, such as
  system configuration, are not checked. `danger-full-access` has no
  sandbox, so none of these checks apply to it.
- The sandbox depends on unprivileged user namespaces on Linux; see
  [sandbox](#sandbox-and-network).
- The SDK installs a native CLI package of about 400 MB for the host
  platform. Dependabot updates the exact pin; review CLI behaviour changes
  (tools, configuration keys, sandbox) before merging. A real-CLI test fails
  when the tool set changes.
- Tests use a loopback Responses fixture only. Request formats that a newer
  CLI sends (such as tool definitions as input items) must be accepted by
  the proxy; check one real turn after each update.

## Tests

`tests/codex-backend.test.ts` drives the real SDK against a fake CLI
(`tests/codex-fixture.ts`): arguments, environment, sessions, text, errors,
attachments, busy threads and process clean-up. `tests/codex-cli.test.ts`
runs the pinned real Codex CLI against a loopback Responses fixture, with
canary credentials, configuration, skills and `AGENTS.md` in a fake home and
project, and a recording HTTP proxy that must see no connection. It checks
the exact tool set, resume after restart, sandboxed tool commands (no key,
no writes or network unless configured, refused escalation, no leftover
processes) and cancellation, also of a CLI that ignores `SIGTERM`. The fake
CLI tests also check that Pogo's pipes close while a process without the
marker holds the CLI's output, and do not grow over repeated cancellations.

The tests do not depend on the host's `PATH` layout. They give each backend
a toolchain directory (`tests/codex-toolchain.ts`: links to the host
programs that the tests run) as `extraPath`. The fake CLI starts its own
processes by absolute path. The default-`PATH` test accepts either result
of the host: the helper directory plus its qualifying system directories,
or the clear start-up failure when there are none. Sandbox tests skip when
the sandbox cannot start with the backend's `PATH`. No test contacts a
provider.

[sdk]: https://developers.openai.com/codex/sdk
