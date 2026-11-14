# CLIProxyAPI for Pogo

## Portable bootstrap

Run this sequence from the Pogo checkout on the **new host**, after explicit
operator approval. It requires mise, the repository's pinned Bun, and installed
dependencies (`mise install`, then `make deps`). It creates a separate local
proxy, not a Slack bot runtime. No global OpenCode config, service, timer, or
existing proxy installation is changed by the bootstrap.

Use the official [v8.0.54 release][release] and its [pinned configuration
example][v8-example]. Do not copy legacy top-level `host`, `auth-dir`, or
`api-keys` client-list examples into this v8 configuration. The
[mise GitHub backend][mise-github] selects the host's release asset and verifies
available checksums/provenance. Keep verification enabled.

```sh
PROXY_TOOL='github:router-for-me/CLIProxyAPI[rename_exe=cliproxyapi]@8.0.54'
mise install "$PROXY_TOOL"
mise exec "$PROXY_TOOL" -- cliproxyapi --help
```

Keep `PROXY_TOOL` set in the terminals used below. This pin does not install a
global wrapper named `cliproxyapi` and does not configure automatic updates.

### Create private local configuration

The following Bun snippet creates `.local/cliproxyapi/` **only if it does not
already exist**. It generates a random client key without printing it, stores
private files with mode `0600`, and uses an OAuth directory with mode `0700`.
The directory is already gitignored. Never copy its contents into a commit,
agent conversation, or another host's setup transcript.

Optional Go upstream: first have the operator store their raw OpenCode Go key
in a new private regular file, mode `0600`, through a password manager or hidden
terminal input. Set `CLIPROXYAPI_GO_KEY_FILE` to that file's **path**, not its
contents. Do not request the key in chat or type its value into a command.
Without this variable, the snippet configures only OAuth-backed subscriptions.
With it, the snippet reads Go's public catalog and writes an explicit snapshot
of chat-model mappings; it makes no authenticated Go inference request.

```sh
mise exec -- bun - <<'BUN'
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const root = resolve(".local/cliproxyapi");
let go;
const keyPath = process.env.CLIPROXYAPI_GO_KEY_FILE;
if (keyPath) {
  const info = await lstat(keyPath);
  if (!info.isFile() || (info.mode & 0o077) !== 0)
    throw new Error("Go key must be a private regular file.");
  const key = (await readFile(keyPath, "utf8")).trim();
  if (!key || /\s/.test(key)) throw new Error("Invalid Go key file.");
  const response = await fetch("https://opencode.ai/inference/go/v1/models", {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Cannot fetch public Go catalog.");
  const catalog = z.object({ data: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
    type: z.string(),
  })) }).parse(await response.json());
  const models = catalog.data.filter((model) => model.type === "chat")
    .map(({ id }) => ({ name: id, alias: `opencode-go/${id}` }));
  if (!models.length) throw new Error("Public Go catalog has no chat models.");
  go = [{
    name: "opencode-go",
    "base-url": "https://opencode.ai/inference/go/openai/v1",
    headers: {
      "User-Agent": "$User-Agent",
      "x-opencode-session": "$x-opencode-session",
    },
    keys: [{ "api-key": key }],
    models,
  }];
}

await mkdir(dirname(root), { recursive: true, mode: 0o700 });
await mkdir(root, { mode: 0o700 }); // EEXIST: stop, never overwrite.
const auth = join(root, "auth");
await mkdir(auth, { mode: 0o700 });
const clientKey = randomBytes(32).toString("hex");
const config = {
  "config-version": 8,
  server: {
    host: "127.0.0.1", port: 8317,
    "commercial-mode": true,
    discovery: { enabled: false },
  },
  management: {
    "allow-remote": false, "secret-key": "",
    "disable-control-panel": true, "disable-auto-update-panel": true,
  },
  access: { "api-keys": [clientKey] },
  oauth: { "auth-dir": auth },
  observability: {
    logs: { debug: false, "request-log": false },
    pprof: { enable: false },
  },
  plugins: { enabled: false },
  ...(go ? { "api-keys": { "openai-compatibility": go } } : {}),
};
const save = (name, value) => writeFile(join(root, name), value, {
  flag: "wx", mode: 0o600,
});
await save("client.key", clientKey);
await save("config.yaml", Bun.YAML.stringify(config));
console.log(`Created ${root}`);
console.log(`OpenCode key reference: {file:${join(root, "client.key")}}`);
BUN
```

An error can leave a partial new directory. Inspect it privately before choosing
a new destination; do not rerun with overwrite flags or delete credential state.
The reference printed above is non-secret; the referenced file is secret.

The v8 boundary is deliberate: `access.api-keys` authenticates **proxy clients**;
`api-keys.openai-compatibility[].keys` holds **upstream Go credentials**;
`oauth.auth-dir` holds subscription refresh tokens. Management stays disabled
with an empty `management.secret-key`; no management password is needed.
`server.commercial-mode: true` disables the pinned server's request-capture
middleware. `request-log: false` alone still permits error-body capture in
that release. Keep application output private; do not paste raw failures into
chat or enable debug logging while handling credentials.

### Sign in, then start in the foreground

The operator runs the desired [Codex][codex-login] and/or
[Claude][claude-login] sign-in in their own interactive terminal. They complete
browser login, MFA, and consent. Do not capture or relay persistent credentials
through agent tools. These are subscription routes, not paid API-key fallbacks;
account entitlement, limits, and provider terms still apply.

```sh
mise exec "$PROXY_TOOL" -- cliproxyapi \
  --config "$PWD/.local/cliproxyapi/config.yaml" --codex-login
mise exec "$PROXY_TOOL" -- cliproxyapi \
  --config "$PWD/.local/cliproxyapi/config.yaml" --claude-login
mise exec "$PROXY_TOOL" -- cliproxyapi \
  --config "$PWD/.local/cliproxyapi/config.yaml"
```

Callback ports are 1455 for Codex and 54545 for Claude. Complete each flow on
the correct host; remote/headless callback forwarding needs operator planning.
Starting the foreground proxy is a separate approved action. If port 8317 is
occupied, inspect its owner; do not stop an existing proxy to make this work.
No service installation, login persistence, or updater is implied.

### Connect OpenCode and Pogo

1. Configure the default OpenCode provider through
   [Pogo's profile guide](agents/default-opencode.md): provider `openai-proxy`,
   endpoint `http://127.0.0.1:8317/v1`, and the generated `{file:…/client.key}`
   reference. Configure [global child agents](agents/agent-profiles.md) only
   after discovery, proposal, and operator approval. Do not overwrite global
   provider authentication or enable a paid fallback implicitly.
2. Check unauthenticated `/v1/models` returns 401/403, then use the client key
   **inside a local process**, not `curl -H` arguments, for authenticated model
   discovery. Print model IDs only, never raw responses or headers. Model
   discovery is not an inference test. Confirm `gpt-6.1-sol` exists before
   choosing the default; Go aliases do not create that subscription model.
3. Go models use explicit aliases such as `opencode-go/glm-5.3`, keeping them
   separate from subscription names. The saved list is a public-catalog
   snapshot, not runtime discovery; update mappings deliberately when needed.
   Read [Go's coding-use and privacy requirements][go] before selecting models.
   The caller must supply its own identifying `User-Agent` and a stable
   `x-opencode-session` **per conversation**. The `$…` header values above copy
   incoming headers; they do not invent a missing session or use one global ID.
4. Follow [Slack batch setup](setup.md), reuse the live Bowser App ID, and
   register additional bots with private token references. Pogo's `backend.url`
   addresses OpenCode, not port 8317. Pi uses this proxy only with an explicit
   `provider` configuration and a supported model (DeepSeek Go or Claude
   Haiku 5.5); see
   [Pi Durable crew](agents/default-opencode.md#pi-durable-crew).
   A `claude` or `codex` backend also needs an explicit `provider` with this
   `/v1` endpoint and the client-key variable; see [Claude backend](claude.md)
   and [Codex backend](codex.md).
   Keep only one live Socket Mode listener per registration.
5. Obtain consent for actual model requests, then verify a Slack mention and
   same-thread follow-up. A running proxy, provider listing, or Socket Mode
   connection alone is not end-to-end success. Enable services only if asked.

## Original machine: example operator installation

The remaining sections record one existing installation. Its paths, wrappers,
services, and update timer are **not installed by the portable steps above**.
Do not assume these units or credentials exist on a new host.

CLIProxyAPI is installed separately from Pogo through mise. It listens only on
`http://127.0.0.1:8317`. Client-key authentication is required; management APIs,
the management panel, LAN discovery, and profiling are disabled.

### Locations

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

### Account sign-in

Run these commands in your own terminal and complete each browser flow:

```sh
cliproxyapi --codex-login
cliproxyapi --claude-login
```

The local callback ports are 1455 and 54545 respectively. Authentication files
are discovered by the running proxy. Subscription limits and provider terms
still apply. No provider request is made by the installation health check.

### OpenCode Go upstream

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

### Automatic updates

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

[release]: https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.54
[v8-example]: https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/v8.0.54/config.example.yaml
[mise-github]: https://mise.jdx.dev/dev-tools/backends/github.html
[codex-login]: https://help.router-for.me/configuration/provider/codex.html
[claude-login]: https://help.router-for.me/configuration/provider/claude-code.html
[go]: https://opencode.ai/v2/docs/console/go
