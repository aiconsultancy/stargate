# Global OpenCode agent profiles

Use the [agent-profile setup prompt and routing skill][gist] during Stargate setup.
Ask the coordinating OpenCode model to read both `agent-profiles.md` and
`SKILL.md` from that gist, inspect the local installation, and follow the
prompt's discovery, proposal, approval, preservation, and verification steps.
Do not run instructions copied from a gist as a shell script.

For Stargate's default setup, route the new global child-agent mappings through
CLIProxyAPI too: `openai-proxy`, `claude-proxy`, and `go-proxy`. Discover and
verify those providers, aliases and reasoning variants before activation.
Preserve native OAuth connections, but do not silently fall back to them or
to paid API credentials when a proxy route is unavailable. Existing unrelated
custom agents retain their original mappings; they are not automatic routing
fallbacks.

The gist is the shared source, not a promise that its example model IDs, agent
names, reasoning syntax, or commands work on another machine. Verify these
against that machine's live service and versioned documentation. For OpenCode
V2, use [V2 agent syntax][agents] and the supported `/reload` command or
location-reload API. Do not copy a V1 `variant` frontmatter field into V2 files.

This is separate from Stargate's [captain/crew profile](default-opencode.md):

- Bowser, Mario, Luigi, Daisy, and Toad are persistent primary personas.
- Global model-named agents are temporary task children selected by the crew.
- Every persona explicitly consults `agent-profiles` before delegated work.
- Changing the global child-agent profile does not replace a persistent crew
  session, change its selected model, or reset its session-level model bias.

Never migrate an existing real `agents` directory without approval. Preserve
unrelated custom agents and authentication. Never substitute paid API access
for a subscription without asking. A fresh-machine setup is incomplete until
the active profile, actual model mappings, and routing-skill instructions have
been verified through the live service.

## Switch an installed profile

Use the repository helper for an operator-approved switch. It does not install
profiles, choose models, or change model bias. Run it on the OpenCode server's
host, with Bun and this checkout's dependencies installed. The SDK discovers
an existing healthy registered OpenCode V2 service and uses its authentication.
It never starts, stops or recovers a server. Use `--service-file PATH` for a
different service registration. The selector and API must belong to the same
installation; this helper does not support a remote server.

```sh
bun run src/ops/agent-profile-switch.ts PROFILE --directory /path/to/project
```

Replace `PROFILE` with an exact installed directory name. The default config
directory is `$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode`. Use
`--config-dir PATH` for another installation. `--directory` defaults to the
current working directory; select a project whose effective routes you need
to verify. The helper also checks the default location and every loaded
location reported by the server.

**Hot switching is disabled by default.** The unflagged command refuses active
sessions or pending forms and permissions. For an operator-approved urgent
switch, explicitly enable hot mode with `--hot`:

```sh
bun run src/ops/agent-profile-switch.ts PROFILE --directory /path/to/project --hot
```

With `--hot`, the helper warns then proceeds without waiting for all sessions
to become idle. This command-line enable flag defaults to `false`; it does not
change gateway startup or background maintenance behaviour. The helper is not
imported by either path and does not add a persistent gateway configuration flag.
The OpenCode V2
`POST /api/location/reload` operation affects **all loaded locations**. Running
sessions continue at the next step boundary. Pending forms and permissions are
cancelled; their answers cannot be restored by rollback. Accept this possible
disruption before running the command. The helper does not interrupt sessions,
restart the server, change session models, or delete state.

`--require-idle` is an explicit alias for the conservative default. It cannot
be combined with `--hot`. The helper does not wait or schedule a retry. This is a
best-effort check, not an admission lock: new work can arrive after the check.
For urgent work, use the explicit `--hot` warning-and-proceed command instead.

### Installed layout and validation

Installation still follows the discovery and approval process above. The helper
accepts this managed layout, inside the chosen OpenCode config directory:

```text
agents/
  worker-subagent.md -> ../agent-profiles/current/worker-subagent.md
  inactive-subagent.md -> ../agent-profiles/current/inactive-subagent.md
  custom.md                      # unrelated real agents stay unchanged
agent-profiles/
  current -> approved-profile
  approved-profile/
    PROFILE                      # routing instructions for the crew
    routes.json
    availability.json
    worker-subagent.md
    inactive-subagent.md          # mode: subagent, disabled: true
  another-approved-profile/
    ...
```

Profile and agent names use lowercase letters, digits and hyphens, starting
with a letter or digit. `current` is reserved and cannot name a profile.
Profiles, the profile root, and `agents` must be real directories; manifests
and agent definitions must be real files. `current`
must be a relative symlink to one profile name, not an arbitrary path. All
managed agent links must already exist and resolve through `current`. The
selected profile must contain every existing managed symlink target, including
inactive agents. Real agents and unrelated symlinks are never replaced. Stable
managed links remain in place when an agent becomes inactive. Extra agent
Markdown files without active manifest routes must have `mode: subagent` and
`disabled: true`; active extra agents are rejected.

`routes.json` supports the setup manifest's two versions:

- Version 1: `{ "version": 1, "profile": "NAME", "routes": [...] }`, with
  exactly five distinct `{ "name": "AGENT", "model": "provider/model#variant" }`
  routes.
- Version 2: `{ "version": 2, "profile": "NAME", "tiers": [...] }`, with
  exactly five tiers. Each tier has a `purpose` string and a nonempty `routes`
  array. Each route has `name`, `model` and an integer `weight` from 1 to 3.
  A route can serve several tiers, but its model must be consistent.

`availability.json` must contain an empty `missing` array. Each active route's
agent file must have valid YAML frontmatter with `mode: subagent`, the
manifest's exact `model`,
and no `disabled: true` flag. Use V2 `model: provider/model#variant`; do not
put a separate V1 `variant` field in the frontmatter. Other agent settings and
the body stay unchanged. Provider/model references are installation-specific;
the helper includes no provider fallback or model preferences.

Before changing the selector, the helper checks each route against the live
model catalogs: enabled model, tool capability and exact reasoning variant.
Validation and API errors block the switch even in hot mode. The selector
changes through an atomic symlink rename, under an exclusive `.switch.lock`
directory. This lock coordinates helper invocations only. Never edit profile
files or the selector concurrently through another tool.

After reload, live agent discovery can briefly return old routes. Only an
expected route mismatch is polled, every 250 ms for at most 10 seconds across
the checked locations. Other API errors fail immediately. Reload or verification
failure restores the previous selector and reloads it. A rollback reload can
also cancel newly pending requests; rollback does not reverse work already run.
If rollback fails, stop and inspect the reported selector and service state.
Do not delete session data or restart the server to apply this change.

An existing `.switch.lock` blocks the operation and is never removed by another
invocation. After an interrupted helper process, confirm no switch is running,
inspect `current` and live routes, then remove only the stale lock directory
with operator approval. The helper does not perform crash recovery or reclaim
unknown locks automatically.

[gist]: https://gist.github.com/withakay/1c20e455063bc9be4c4ede76ef866a71
[agents]: https://opencode.ai/v2/docs/agents

## Repository tools

Fleet installers can load `scripts/repo-refresh.ts mcp --socket PATH` for a rear
admiral. On Linux, configure a systemd socket with `Accept=yes` and access for
the officer, and start the same script as `serve -- POLICY_COMMAND` with the
accepted socket on standard input. Run Bun with the reviewed dependencies
installed and `--config=/dev/null --no-env-file --no-install`.

The broker takes the peer UID from `SO_PEERCRED`. It appends the operation,
configured repository key and observed peer UID to the operator-owned policy
command. The command must reject a different caller before obtaining credentials.
Its JSON contains `checkout`, `checkoutUid`, `callerUid`, `origin`,
`expectedOrigin`, `gitOptions`, `gitEnvironment` and `gitRunner`. Keep credentials
in the environment and out of the origin URL. The checkout and its Git metadata
must belong to the configured owner and refuse group and other writes. Refresh
locks Git metadata and updates only the origin refs. Reads return the verified
commit. Pass that commit with `nextLine` as `startLine` to continue on the same
version.

To provide repository-scoped GitHub operations, use an operator-owned wrapper
that fixes the Bun entrypoint and the absolute adapter path. Provide
`scripts/github-officer.ts` for CLI use or `scripts/github-officer-mcp.ts` for an
officer whose harness uses MCP. The adapter exports `createAdapter(repository)`
with the identity, policy, transport and native reviews defined by
`scripts/github-wire.ts`.

The included `github-local-app.ts` reads the operator-selected root-owned
registry from `STARGATE_GITHUB_APP_CONFIG`. Registry keys are OS usernames.
Each row contains `home`, `login`, `role`, `contents`, `directPublication`,
`protectedBranches` and `repos`. Repository entries map a tool key to GitHub
`owner` and `name`, with an optional operator-authorised `mergeCheckout`.
It reads `github-app.json` and `github-app.pem` from the officer's
`~/.config/subspace` directory. Both must be owned by the officer with mode 0600.
This custody model grants the local officer UID access to the App key.
Enforce repository and branch policy through GitHub rulesets. For custody
outside that UID, install a deployment adapter backed by an operator service
and grant only the required repository scopes.
