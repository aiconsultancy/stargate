# Provider usage and quota

`/pogo usage` opens a private provider-usage modal. It calls no model, creates
no session and posts no account data to the channel. The existing `/pogo`
registration and `commands` scope are sufficient; no new slash command or
scope is required. Updated manifests add `usage` to the command hint.
Use the command from the main message composer, not a thread composer.

Captain and assigned crew can use `pogo_quota` with `{}`. This includes Pi
crew with coding tools enabled. It uses the existing crew permission and
caller checks. Pi tools-off reporter turns stay tools-off. Slack reads use
the authenticated captain-location RPC and normal app, workspace, user and
channel access rules, including denies. Other backends can omit this feature.

## What the snapshot means

- Claude and Codex subscription percentages used and remaining, reset times,
  reported scopes, observation times and cache status.
- These are **not token counts**, cost totals or remaining dollars. Percentages
  can be weighted by the provider. Never convert them into estimated tokens.
- Each credential gets a synthetic account label such as `claude-1`. Labels
  are ordinal within a snapshot, not durable account identities. Accounts are
  separate; do not add their percentages.
- Only recognized windows are returned. Missing windows, unavailable accounts,
  and unsupported scopes are unknown, not zero usage or unlimited quota.
- An inactive model scope does not prove model entitlement. A family label
  does not establish applicability to every version or fast/thinking variant.
- A reset time that has passed makes the current allowance unknown. A reset
  does not prove that an account is now full.
- Reads cache for up to 60 seconds per plugin binding. Reopen the command to
  request another snapshot. An optional watcher polls separately for crew notices.
- OpenCode Go and burn-rate estimates are not implemented. Adama can use
  the data with existing `pogo_model` controls; reading quota does not
  itself switch models or change sessions.

## Configure the reader

Quota collection is opt-in. Add `quota` to the existing `pogo.crew` plugin's
**options**, preserving its namespace, captain pin, paths, team and other
settings. Use the same options for captain and OpenCode crew locations.
No gateway backend setting or session identity needs to change.

```json
{
  "quota": {
    "baseURL": "http://127.0.0.1:8317",
    "managementKeyFile": "/absolute/private/path/management.key"
  }
}
```

The proxy must already be configured for authenticated v8 management access.
Enabling management, creating credentials and changing services are separate
operator actions. This feature does not enable them. The key file must be a
regular file owned by the runtime user, with no group/other permissions, no
symlink and at most 4096 bytes. Never put the key value in chat, configuration
examples or CLI arguments. Without options the tool returns `not-configured`.

Only literal loopback HTTP origins are accepted (`127.0.0.1` or `[::1]`).
Redirects fail closed. Response reads have an eight-second overall deadline
and a one-MiB limit per response. The reader supports at most ten account rows
and sixteen recognized windows per account; larger inventories fail closed
rather than silently omit accounts.

## Crew quota notices

A gateway can poll the same quota reader every two minutes and post changes
to a configured Slack channel. It publishes a separate JSON policy for crew
launchers and never runs inference to check allowance.

Add this to the gateway configuration and restart it. Only one gateway
should own the file and post the notices.

```json
{
  "quotaWatch": {
    "proxy": {
      "baseURL": "http://127.0.0.1:8317",
      "managementKeyFile": "/absolute/private/path/management.key",
      "accounts": { "claude": ["crew@example.com"] }
    },
    "report": { "bot": "captain", "channel": "C123456" },
    "stateFile": "/absolute/private/path/quota.json",
    "providers": ["claude", "codex"]
  }
}
```

Choose a channel the reporting bot can post to and the affected captains
watch. This grants outbound delivery to that channel without permitting
incoming conversations there. Explicit channel denies still apply.
The example account selector is optional. With dedicated
captain and crew logins, list the crew login emails for each applicable
provider so reserved balances cannot clear a crew pause. Those selectors
are kept in the gateway configuration and never appear in snapshots,
policy files or Slack notices. A missing selected login is unknown.
The default provider list is Claude and Codex; set it to `["claude"]` if
the Codex workers use a local login outside this proxy. A proxy observation
only applies to workers using the same provider account. To watch a native
Codex login alongside proxy-based Claude, set `nativeCodexFile` to the
absolute path of its trusted local quota receipt and include `"codex"` in
`providers`. Stargate will use only that receipt for Codex and will skip Codex
proxy calls.

The host should publish the minimum remaining percentage from the native
Codex account's quota windows as
`{"remainingPercent":7,"observedAt":1794744000,"resetAt":null}`. Both
timestamps are epoch seconds. Use the earliest measured reset time when
available and refresh the file more often than every two minutes. Write it
atomically as a private file owned by the gateway user, without any account
identifiers or authentication material. An invalid, absent, stale or
expired receipt does not clear the last verified policy.

For each account, the watcher uses the lowest remaining percentage of its
active subscription limits. It uses the highest of those per-account
balances within a provider pool, without adding them. Missing, expired or
stale readings preserve the last verified mode and its original timestamp.
A fresh balance above 25% is required to announce normal allowance after a
restriction.

- At 25% remaining or less, permit one crew worker of that type per captain.
- At 15% or less, hold new launches and resumes of that type. Active runs
  should checkpoint at a safe point and retain their claims.

The watcher writes the last verified mode atomically as
`{"claude":{"mode":"limited","observedAt":1794744000}}`. The timestamp is
epoch seconds. Codex uses the same fields under `codex`. Mode is
`normal`, `limited` or `paused`. A launcher may impose a tighter local
limit and owns the decision to checkpoint, hold or resume.

The watcher records the transition before sending its notice. Repeated
observations and gateway restarts do not repeat it. Delivery failures log
a fixed warning and the crew policy remains available. Captains and their
conversation backends do not consume or enforce this crew policy.

## Credential boundary

The host reads `GET /v8/management/credentials` internally, then uses
`POST /v8/management/requests/api-call` only for these fixed upstream GETs:

- Claude: `https://api.anthropic.com/api/oauth/usage`
- Codex: `https://chatgpt.com/backend-api/wham/usage`

The proxy substitutes `$TOKEN$` server-side. Models cannot choose an upstream
URL, account, method, header, key or reset action. Keys, credential identifiers,
emails, account IDs, upstream error bodies and raw SDK errors are not returned
or logged. Cache holds sanitized snapshots only. Provider failure returns
unavailable data rather than reusing an older successful balance.

These provider status routes are the management UI's current implementation,
not a stable public billing API. Format changes can make a snapshot unavailable.
The collector does not drain the destructive observability usage queue, spend
reset credits, reset allowances, run inference or change provider routes.

Sources: [CLIProxyAPI v8 management API][management] and the management UI's
[Claude][claude] and [Codex][codex] quota readers. Slack documents command
response timing and visibility in [Implementing slash commands][slash].

[management]: https://help.router-for.me/management/apiv8.html
[claude]: https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/main/src/features/quota/providers/claude/data.ts
[codex]: https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/main/src/features/quota/providers/codex/data.ts
[slash]: https://docs.slack.dev/interactivity/implementing-slash-commands
