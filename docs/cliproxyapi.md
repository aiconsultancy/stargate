# Local CLIProxyAPI installation

CLIProxyAPI is installed separately from Pogo through mise. It listens only on
`http://127.0.0.1:8317`. Client-key authentication is required; management APIs,
the management panel, LAN discovery, and profiling are disabled.

## Locations

- Command: `~/.local/bin/cliproxyapi`.
- Pinned tool: `~/.config/cliproxyapi/mise.toml`.
- Proxy config: `~/.config/cliproxyapi/config.yaml`.
- Client key: `~/.config/cliproxyapi/client.env`, mode `0600`.
- Provider credentials: `~/.local/share/cliproxyapi/auth/`, mode `0700`.
- User service: `cliproxyapi.service`.

Do not print the config, client key, or provider credential files into chats or
logs. Pogo/provider configuration can reference the key through environment
variable `CLIPROXYAPI_API_KEY`. Installation does not automatically modify
OpenCode or Pogo provider settings.

## Account sign-in

Run these commands in your own terminal and complete each browser flow:

```sh
cliproxyapi --codex-login
cliproxyapi --claude-login
```

The local callback ports are 1455 and 54545 respectively. Authentication files
are discovered by the running proxy. Subscription limits and provider terms
still apply. No provider request is made by the installation health check.

## OpenCode Go upstream

OpenCode Go is configured as a separate v8 `api-keys.openai-compatibility`
upstream named `opencode-go`, using
`https://opencode.ai/inference/go/openai/v1`. Its aliases are explicitly named
`opencode-go/<model-id>` so they cannot silently share a route with a Codex or
Claude subscription model. No global prefix-routing setting was changed.

The upstream model list is a snapshot of Go's public catalog, not automatic
discovery. Refresh that list when new Go models are needed. Existing Bowser
OpenCode model definitions are separate; proxy discovery does not add them to
the OpenCode config automatically.

Go requires coding-agent traffic, an identifying User-Agent, and a stable
session ID per conversation. The upstream forwards the caller's `User-Agent`
and `x-opencode-session` headers. Clients must supply them; a missing session
header is not replaced by a fabricated global session ID.

The API token is stored in the private proxy config. The private input file
`~/.config/cliproxyapi/opencode-go.key` must also remain mode `0600`. Never print
either file. A private config backup was made before adding this upstream.
The running proxy required one restart before the new routes were published;
check model discovery after configuration changes rather than assuming reload.

See [OpenCode Go](https://opencode.ai/v2/docs/console/go) for current model
availability, session-header requirements, quota, and privacy settings.

## Automatic updates

`cliproxyapi-update.timer` checks daily at **04:00 local time**, with a random
delay of up to 15 minutes. Missed checks run when the user manager next starts.
Updates stay within **stable v8**; major upgrades require operator action.

The updater uses mise release verification, pins the selected version, and
restarts an active proxy only when a newer version was installed. A stopped
proxy stays stopped. Failed startup/HTTP checks restore the previous version
and attempt to restart it. Older binaries are retained by mise for rollback.
Updates can interrupt active model requests; rollback cannot undo upstream
side effects or credential-file changes made by a new release.

```sh
systemctl --user list-timers cliproxyapi-update.timer
systemctl --user start cliproxyapi-update.service
journalctl --user -u cliproxyapi-update.service -n 30
systemctl --user disable --now cliproxyapi-update.timer
```

The proxy itself is started but is not enabled at login by installation.
To enable it explicitly:

```sh
systemctl --user enable cliproxyapi.service
```

Timers and services depend on the systemd user manager. Operation after logout
requires user lingering or an active login session.
