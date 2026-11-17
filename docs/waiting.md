# Waiting responses

Each bot can set its waiting response delay and phrase interval:

```json
{
  "displayName": "Adama",
  "waiting": { "delayMs": 5000, "intervalMs": 10000 }
}
```

These fields go inside a bot registration, next to `id` and `backend`.
The default delay is 5 seconds. The default phrase interval is 10 seconds.
`delayMs: null` disables waiting responses. `delayMs: 0` starts immediately;
zero does not mean disabled. Delays must be whole milliseconds from 0 to
3,600,000. Intervals must be whole milliseconds from 1,000 to 3,600,000.

Waiting phrases use `displayName`, then the configured OpenCode agent ID,
then the bot registration ID. No captain name is built into the phrases.
The phrase collection contains 100 short status messages. They do not report
tool output or claim that a particular check has completed.

## Change delay through a captain

An allowed human can also send `@your-captain /config waiting 3` or
`@your-captain /config waiting off` in Slack. The gateway writes this same
override without starting a captain turn. See [meta commands](meta-commands.md)
for access checks, current-value reads and reserved settings.

With the trusted captain/crew plugin enabled, ask the captain:

- “Change your waiting response time to 3 seconds.”
- “Change your waiting response time to 5 seconds.”
- “Change your waiting response time to off.”
- “Change your waiting response time to zero seconds.”

The captain maps the request to `stargate_waiting` with `seconds: 3`, `5`, `"off"`,
or `0`. The tool accepts whole seconds from 0 to 3,600, or `"off"`.
It uses the existing `stargate_crew` permission and verifies the real session's
captain identity, root status, and configured workspace before writing.
Workers, child sessions and captains from other workspaces cannot use it.
Default gateway tool permissions remain deny; no tool is granted implicitly.
Existing trusted captain sessions need no new tool grants. Runtime captain
verification rejects workers and children even if they have `stargate_crew` access.

The tool saves only a delay override in the captain workspace's
`.local/stargate-waiting/<agent-hash>.json`, with file mode `0600`. It does not edit
`stargate.json`, credentials, access rules or global OpenCode configuration.
The gateway reads the override before each subsequent turn; no gateway
restart is needed. An active turn keeps its initial waiting settings.
The configured phrase interval remains unchanged.

The override applies to registrations using the same OpenCode workspace and
agent ID. Separate teams need separate captain workspaces. The gateway and
OpenCode plugin must see the same workspace filesystem. For remote OpenCode
without a shared filesystem, edit `stargate.json` and restart Stargate instead.
Missing or invalid overrides fall back to the bot's configured waiting values.
Delete the override file to restore those values. Natural-language changes
require the installed plugin version that supplies `stargate_waiting`; refresh
the OpenCode plugin after upgrading Stargate if the tool is not available.
