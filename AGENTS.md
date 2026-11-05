# Pogo agent instructions

## Project

Pogo is a Bun/TypeScript Slack gateway. One process hosts multiple Slack app
registrations. Built-in backends connect to OpenCode V2 or embed Pi Durable;
trusted local modules can implement the same adapter interface.

Read `README.md` for setup and limits, `docs/design.md` for architecture, and
`docs/cliproxyapi.md` for the separate local proxy installation.
For Slack bot provisioning, follow `docs/setup.md`. Create registrations for
this gateway; do not scaffold or run a replacement Bolt application.

## Commands

`mise.toml` owns task commands. The Makefile is only a forwarding wrapper;
do not duplicate task implementations there. Bun is pinned through mise.

```sh
mise install
make deps
make check
make format
make pogo ARGS='--help'
make config-check ARGS='--config pogo.example.json --schema-only'
```

`make check` runs TypeScript, Biome, and Bun tests. Run the smallest relevant
test while changing behavior, then the full check before completing code work.
`make init` requires a real terminal and collects tokens without echoing them.
Pass non-secret CLI options through `ARGS`, or `mise run TASK -- OPTIONS`.

## Code boundaries

- `src/config.ts`: strict boundary validation and environment references.
- `src/cli.ts`, `src/setup.ts`, `src/service.ts`: CLI, wizard, user service.
- `src/slack.ts`: one Socket Mode/Web API connection per bot registration.
- `src/routing.ts`: event validation, access rules, conversation identity.
- `src/gateway.ts`: per-thread ordering, backend execution, reply delivery.
- `src/store.ts`: SQLite queue, session mappings, delivery progress.
- `src/backend.ts`, `src/backends/`: backend contract and implementations.
- `src/runtime.ts`: process ownership, startup, cancellation, cleanup.

Keep backend adapters independent of Slack. Preserve isolation by bot, app,
workspace, backend settings, channel, and thread. Changing backend settings
selects a new session namespace; never reuse another backend's session ID.

## Engineering

- Use strict TypeScript and existing Zod schemas at input boundaries.
- Reuse project helpers, Bun, or the standard library before adding packages.
- Honour `AbortSignal`; cancelling a wait must also stop underlying agent work.
- Keep SDK/runtime API usage consistent with installed dependency versions.
- Use OpenCode V2 documentation; do not substitute V1 APIs or configuration.
- Keep Pi package versions aligned. Pi Durable's API is experimental.
- Add focused tests for non-trivial logic. Existing tests use `bun:test`, real
  SQLite, local HTTP fixtures, and fake Slack delivery; no paid provider calls.
- Do not introduce `any`, type suppression, or disabled lint rules to hide errors.
- Keep documentation and CLI help aligned with supported options and limits.

## Safety and credentials

- Never commit `pogo.json`, its `.env` companion, provider credentials, runtime
  databases, copied API responses, or installed machine-specific service files.
- Never request tokens in chat or accept secret values as CLI arguments.
- For the operator-approved Slack CLI login flow, a single-use challenge may
  be relayed only to complete `login --ticket --challenge`. Never persist that
  exchange, or confuse it with permission to collect persistent credentials.
- Never log raw SDK exceptions, request headers, prompts, or credential files.
- Keep allowlists nonempty and fail closed. Reject messages sent by bots.
- Only on explicit operator request, allow `*` for users or channels/DMs.
  `deniedUsers` and `deniedChannels` always override allows, including `*`.
  Keep app/workspace routing and bot rejection; missing deny lists default empty.
- Tool access is separate from Slack access. Default OpenCode tools to deny
  and Pi tools to none; directories are starting locations, not sandboxes.
- Persist accepted requests before Slack ACK. Delivery retries must not rerun
  tools. Interrupted execution has uncertain outcomes; do not blindly replay it.
- Do not claim exactly-once external side effects or delivery.
- Keep SQLite state and credential files private. Never delete state to fix
  an error without explicit authorization and an appropriate backup.
- Do not install/start/stop user services, change global OpenCode configuration,
  or edit the separate CLIProxyAPI installation unless the user requests it.
- Pogo's Pi adapter currently lacks configurable proxy endpoints; do not assume
  installing CLIProxyAPI makes that backend use the proxy automatically.

## Git

Work on a feature branch, not `main`. Preserve unrelated user changes. Use
Conventional Commits, for example `feat: add backend endpoint configuration`
or `fix: preserve reply progress after delivery failure`. Stage only intended
project files and inspect the staged diff for credentials before committing.
