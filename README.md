# Stargate

Stargate is a self-hosted gateway that lets you talk to AI agents from Slack
or IRC. It connects to an existing OpenCode V2 server, runs Pi Durable in the
gateway process, or launches Claude Code or Codex through their SDKs. Use one
bot for yourself or run several registrations on one host.

In Slack, each bot has its own app and access rules. Mention the bot in an
allowed channel to start a conversation and reply in the thread to continue
it. Slack Socket Mode uses an outbound connection, so the gateway needs no
public HTTP endpoint. IRC can run on its own or alongside Slack.

## Install

You need Git and [Bun](https://bun.com/) 1.4.4, the version pinned for this
project. Install Bun directly or use `mise install bun` from the checkout
with [mise](https://mise.jdx.dev/). When using mise without shell activation,
run Bun commands as `mise exec bun -- bun …`.

```sh
git clone https://github.com/aiconsultancy/stargate.git
cd stargate
bun install --frozen-lockfile
bun run src/main.ts --help
```

For a versioned install, check out a published tag before installing
dependencies. You can also download and verify that version's source archive
from [GitHub Releases](https://github.com/aiconsultancy/stargate/releases),
then run the last two commands from the unpacked directory. See
[release verification](docs/releases.md#verify-a-release).

## Connect one bot

Choose a backend first:

| Backend                                                 | What to set up                                                                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [Pi Durable](docs/configuration.md#pi-durable)          | Supply a supported OpenAI or Anthropic model ID and its API key. Pi runs in Stargate, with no separate agent server. |
| [OpenCode V2](docs/configuration.md#opencode-v2)        | Start and authenticate your own V2 server. Stargate connects to its URL and uses a directory on that server.         |
| [Claude Code](docs/claude.md) or [Codex](docs/codex.md) | Configure an explicit provider endpoint and credential reference. Follow the backend guide after app setup.          |
| [Custom module](docs/configuration.md#custom-adapters)  | Load a trusted local adapter implementing the Stargate backend contract.                                             |

For Slack, run the wizard in your terminal. It offers OpenCode and Pi Durable,
builds the Slack app manifest, and collects tokens without echoing them.

```sh
bun run src/main.ts init
bun run src/main.ts config check
bun run src/main.ts start
```

Follow the [Slack setup guide](docs/setup.md#configure-your-first-slack-bot) to
install the app, supply credentials and verify a reply. The default
configuration is `pogo.json`; its private companion is `pogo.json.env`. Use
`--config PATH` on each command to choose a different location.

For IRC, follow the [single-bot IRC example](docs/irc.md#one-bot-with-no-slack-app) and
run the same `config check` and `start` commands with your config. You need
accounts on an IRCv3 server with SASL and `account-tag` support.

Start with an allowlist of specific people and conversations and leave agent
tools off. Slack and IRC access rules control who can request work. Tool
permissions control what the agent can do on the host.

## Run and extend

- [Configuration](docs/configuration.md) covers scripted registration, access
  rules, backend settings, and live reload. [Operations](docs/operations.md)
  covers Linux user services, updates, and recovery guarantees.
- [Attachments](docs/attachments.md), [cancellation](docs/cancellation.md),
  [scheduled prompts](docs/cron.md), and [thread context](docs/thread-context.md)
  describe day-to-day Slack use.
- [OpenCode captain and crew](docs/agents/default-opencode.md) explains how to
  share one durable captain session across allowed chat sources and delegate to
  workers. See [multiple instances](docs/instances.md) when running independent
  teams and [IRC](docs/irc.md) for IRC captain and crew accounts.
- [CLIProxyAPI](docs/cliproxyapi.md), the [dashboard](docs/dashboard.md), and
  [nightly maintenance](docs/maintenance.md) each have separate setup.
- See [architecture](docs/design.md), [development](docs/development.md), and
  [contributing](CONTRIBUTING.md) to work on Stargate.

Run `bun link` from the checkout for the `stargate` command. The linked command
needs Bun on `PATH`. The `pogo` alias, `pogo.json`, `maintenance.pogo`, state
paths and service names, the Slack `/pogo` command, and `pogo_*` tools retain
their names for existing installations.

Stargate is available under the [MIT License](LICENSE). Report vulnerabilities
through the [security policy](SECURITY.md). Vendored Effect skills retain
their [upstream license](.agents/vendor/effect-skills/LICENSE).
