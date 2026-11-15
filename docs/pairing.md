# OpenCode device pairing from Slack

`/stargate pair` opens a private Slack modal. It does not run an agent prompt.
Only an explicitly configured operator can use it, in a normally allowed
channel or DM. The modal warns that pairing grants **full OpenCode server
access for 30 days**. It is not read-only or limited to the Slack conversation,
bot, agent, project, or directory.

Review that warning, then select **Generate**. Only that button requests a
single-use code from the bot's existing authenticated OpenCode backend.
The modal then shows copyable, literal URLs and the server-reported lifetime.
Standard OpenCode codes normally last five minutes. Stargate uses `expires_in`
from the response, not a fixed assumed expiry. Local confirmation expiry and
elapsed code lifetime use a monotonic clock, so wall-clock corrections cannot
extend or shorten them. Stargate subtracts elapsed request time from `expires_in`,
then adds the remaining duration to the current wall clock for the displayed
use-before time. This is a conservative local estimate, not an authorization
deadline. The OpenCode server's expiry remains authoritative.

Copy one URL into the browser on your trusted device. Redeeming **any one**
invalidates all URL aliases. Stargate never opens, fetches, or redeems these URLs.
After pairing, use OpenCode's session list to find the conversation. New
sessions use `<bot name> (slack <conversation ID>)`, for example
`Galactica Captain (slack D123)`. The name comes from `displayName`, then the
OpenCode agent name, then the bot ID. Ordinary bots keep separate thread
sessions even when their titles match. A captain uses its pinned durable
session across chat sources. Existing titles stay unchanged and may
have been changed in OpenCode. A pairing request does not create a session.

## Configure deliberately

Pairing is disabled when `pairing` is absent. Add this non-secret object to
an existing OpenCode bot registration only after the operator approves it:

```json
"pairing": {
  "operators": ["U0123456789"],
  "urls": [
    "http://workstation.tail-example.ts.net:4096",
    "https://opencode.example.com"
  ]
}
```

These are placeholders, not discovered or tested endpoints. Replace them
with the exact human user IDs and already reachable origins. Do not add a
live operator merely to test the feature. Restart Stargate after config changes.

- `operators`: 1–100 exact Slack human user IDs (`U…` or `W…`). No `*`.
- `urls`: 1–5 absolute origins, with an optional port and trailing slash.
  Credentials, paths, query strings, fragments, and non-HTTP protocols fail
  validation. Stargate normalizes origins before constructing URLs.
- Public routes, including Cloudflare routes, require HTTPS. HTTP is allowed
  only for Tailscale `*.ts.net` names or Tailscale address ranges
  (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`). A short MagicDNS name is not accepted;
  use its full `*.ts.net` name or address. This check does not prove reachability
  or tailnet membership.
- Every origin must serve the **same OpenCode server** as `backend.url`,
  including `/auth/connect/:code`. A wrong origin can expose the code to its
  owner. Stargate does not discover origins or verify external routing.
- Tailscale and Cloudflare are independent existing access paths, not modes
  Stargate enables. Keep their access controls. A protected Cloudflare route may
  require its own browser sign-in before OpenCode pairing can finish.
- Normal `access.users` and `access.channels` rules still apply. Both deny
  lists override pairing operators, including when normal allows contain `*`.
- Pi Durable and module backends cannot use this command. The initial
  implementation permits only the built-in OpenCode backend's pairing
  capability. `backend.headersEnv` supplies its existing server authentication.
  There is no separate remote-auth assumption or pairing credential source.

Apply Stargate's regenerated Slack app manifest to the existing app. Pass its
current display name with `stargate manifest --name NAME` to keep that name.
The manifest registers
`/stargate` and enables Socket Mode interactivity. It uses the existing `commands`
bot scope and the same bot-token modal APIs as `/cron`; no new scope is added.
Installing or updating Slack app settings remains an operator action. Editing
a local manifest does not update an installed app. See [setup](setup.md).

## Privacy and failure limits

The secret is sent only in `plain_text` sections in the private modal.
It is not a Markdown link, URL button, channel reply, or unfurled preview.
This avoids making a single-use credential into an automatic Slack link
preview. Slack still receives the secret; private does not mean end-to-end
encrypted or excluded from Slack's retention and administrative controls.
Do not paste it into a channel, agent prompt, log, issue, or external tool.
No QR image is generated: URL-only delivery avoids a new dependency, external
QR service, credential upload, and image persistence.

Stargate does not put codes or generated URLs in SQLite, session prompts, model
tools, application logs, or local persistent artifacts. It keeps only bounded,
five-minute confirmation records in process memory (maximum 128 per bot).
The first accepted click consumes that confirmation before network work.
Repeated clicks and Slack retries cannot mint another code from it. A restart
invalidates pending confirmations; no pairing work is replayed.

Each pairing call has a 15-second deadline and receives shutdown cancellation.
It uses the SDK's `server.pair` (`POST /api/pair`) with existing backend auth,
without retries or redirects. Slack acknowledgement precedes that request.
SDK and Slack failures are logged only as fixed generic messages.
Malformed or foreign interactive payloads are acknowledged without effects.
Expired or revoked owned confirmations receive a private notice.

A timeout, cancellation, process exit, or failed Slack update can leave a code
issued but not delivered. Stargate cannot prove that the server did not issue it.
It does not retry minting or recover the code. Inspect the server and wait for
expiry before deciding whether to request another. Closing the modal does not
revoke a code or the device's 30-day access. Removing an operator stops future
Stargate generation, not access already granted by OpenCode. Use OpenCode's own
device/session controls for revocation where available.

This feature never runs `opencode pair --remote`, starts a CLI process,
enables a tunnel, changes listeners, or modifies OpenCode global settings.
It does not replace the existing Slack bot listener or OpenCode server.

## Official contract

- [OpenCode V2 web and pairing](https://opencode.ai/v2/docs/cli/web/)
- [OpenCode V2 client](https://opencode.ai/v2/docs/build/client)
- [OpenCode V2 OpenAPI](https://opencode.ai/v2/openapi.json)
