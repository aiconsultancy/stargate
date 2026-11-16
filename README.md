# Stargate

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/icons/stargate-light.svg">
  <img src="assets/icons/stargate-dark.svg" width="128" height="128" alt="Stargate logo">
</picture>

Stargate is a self-hosted gateway that lets you talk to AI agents from Slack,
Teams or IRC. It connects to an existing OpenCode V2 server, runs Pi Durable in the
gateway process, or launches Claude Code or Codex through their SDKs. Use one
bot for yourself or run several registrations on one host.

[Stargate icons and artwork](assets/icons/README.md)

In Slack, each bot has its own app and access rules. Mention the bot in an
allowed channel to start a conversation and reply in the thread to continue
it. Slack Socket Mode uses an outbound connection, so the gateway needs no
public HTTP endpoint. IRC can run on its own or alongside Slack. The optional
[Teams transport](docs/teams.md) validates Bot Framework requests on a private
Unix socket and uses managed identity for replies. [Fleet controls](docs/fleet-tools.md)
add verified message evidence and captain dispatch when explicitly configured.

## Install

You need Git and [Bun](https://bun.com/) 1.4.4, the version pinned for this
project. If you use [mise](https://mise.jdx.dev/), run `mise install bun` once
you are inside the checkout. Without shell activation, use
`mise exec -- bun …` for the Bun commands.

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
configuration is `stargate.json`; its private companion is `stargate.json.env`. Use
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
needs Bun on `PATH`. This release completes a breaking product rename: there
are no old command, config, tool, path or service aliases. Existing installations
must follow the [offline migration and bootstrap](docs/hard-cutover.md) before
starting the new release. Keep durable state and immutable message history.

Stargate is available under the [MIT License](LICENSE). Report vulnerabilities
through the [security policy](SECURITY.md). Vendored Effect skills retain
their [upstream license](.agents/vendor/effect-skills/LICENSE).
