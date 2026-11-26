# Microsoft Teams transport

Stargate can run Microsoft Teams registrations alongside Slack and IRC, or on
its own. Add a `teams` entry to the regular configuration, run `config check`,
and start Stargate. No Teams registration or approval control is enabled by
default. The transport uses the same durable queue and backend adapters as the
other chat sources.

## Registration

Create an Azure Bot registration with the Microsoft Teams channel and a
user-assigned managed identity attached to the Stargate host. Set `botClientId`
to that identity's client ID, and use the same identity on the Azure Bot. The
current outbound implementation uses Azure IMDS; it does not take a bot secret
or a developer login from the configuration. It therefore needs an Azure host
with managed identity available.

Set the Bot's messaging endpoint to your public HTTPS hostname followed by
`/api/messages`. Route that exact callback to the private Unix socket defined
by `socketPath`; do not publish the backend server. Give only Stargate and the
trusted reverse-proxy connector access to the socket directory. On Linux the
listener uses `flock` during startup, refuses unsafe directory ownership and
permissions, and creates the socket with mode `0660`. Provision the directory
before starting the service. Keep the application data directory private too.

An example with tools and approval controls left at their defaults:

```json
{
  "teams": [
    {
      "id": "rear-admiral",
      "botClientId": "11111111-2222-4333-8444-555555555555",
      "tenantId": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "socketPath": "/run/stargate/teams/rear-admiral/bridge.sock",
      "access": {
        "users": ["99999999-8888-4777-8666-555555555555"],
        "channels": []
      },
      "backend": {
        "type": "opencode",
        "url": "http://127.0.0.1:4096",
        "directory": "/srv/projects/assigned-repository"
      }
    }
  ]
}
```

Replace the IDs and paths with your deployment's values. Teams configuration
uses exact Entra object IDs, rather than display names or email addresses.
`access.users` must contain at least one UUID. An allowed human can send a
personal message. A channel or group chat must also match `access.channels`
and include a Teams @mention of this bot in the current message. By default,
text-only mentions and mentions of another bot do not select this registration.
On a dedicated conversation, set `access.allowUnmentionedConversations: true`
to accept messages without a bot mention from the explicitly listed conversations.
For channel messages, the channel ID in `channelData.channel.id` is the access
scope even when the activity's conversation ID is different. Denied users and
channels override the allow lists. Wildcards are not supported for Teams.
Registration IDs and socket paths must be unique within the gateway.

The activity must identify the configured bot and tenant. If it carries tenant IDs in
both conversation and channel data, both must agree. Bot senders, self messages,
missing human object IDs and unsupported activity types are refused. Access is
checked again before work and delivery; removing a permitted channel also
blocks replies to its previously stored conversation references.

### Quoted messages

Stargate uses up to three quoted-message references as untrusted context for
the current request. A validated Teams preview contributes up to 512 characters.
Missing, deleted, unvalidated, or ambiguous previews contribute only the
message ID. Quoting a message does not supply an @mention, change the sender,
approve an action, or select the reply destination.

## Authentication and durable replies

Before reading a request body, the listener verifies a Bot Framework RS256 JWT
using Microsoft's published signing keys, issuer, this bot's audience and expiry.
It then checks the signed service URL against the activity and requires the
key's `msteams` channel endorsement. Azure/Entra managed identity tokens are
outbound credentials; they cannot authenticate incoming Bot Framework traffic.
Do not replace token verification with trust in a reverse-proxy header.

Only `POST /api/messages` is accepted. Requests have bounded header, body and
request sizes/timeouts. Invalid authentication is rejected; temporary key-fetch
failures return `503` so Bot Service can retry. The listener acknowledges a
valid request after durable intake. Activity IDs are deduplicated within their
registration and conversation across process restarts. Replies retain the
original conversation and reply activity, even when an OpenCode captain pin is
shared with another transport. Delivery retries do not promise exactly-once
external messages or tool side effects.

Bot Connector credentials are sent only to approved HTTPS Bot Framework service
hosts. Redirects, embedded credentials, arbitrary ports and unrelated service
URLs are refused. Signing-key refreshes are bounded, and unknown key IDs cannot
force an unbounded stream of fetches. Maintain the host clock: verification
allows Microsoft's documented five-minute clock tolerance.

Every process on an Azure VM may be able to request tokens for attached managed
identities. Separate host users and socket permissions protect local callback
handling, but do not turn IMDS identities into per-process credentials. Include
that host boundary in the deployment's threat model.

## Optional native permission decisions

Teams approvals are off while `approvalUsers` is empty, which is its default.
To enable them for an OpenCode backend, set `approvalUsers` to a subset of the
exact UUIDs already permitted in `access.users`. `approvalTTLms` defaults to
600,000 milliseconds and accepts 1,000 through 3,600,000. These settings do not
enable tools or change the backend's tool permission policy; configure those
separately and deliberately.

An example addition to one Teams registration:

```json
{
  "approvalUsers": ["99999999-8888-4777-8666-555555555555"],
  "approvalTTLms": 600000
}
```

A pending native permission is offered only to its originating allowed human
in the same personal Teams conversation. Stargate binds the random decision
token to the backend session, permission request, native input, running stored
job, original human, conversation, permission details and expiry. The backend
must prove that the native permission belongs to that input. Missing proof,
a completed/interrupted job, changed session/request/input or changed
permission details fails closed. A pending permission caused by an IRC message
on a shared captain pin cannot borrow an earlier Teams human's authority.

The user replies exactly `approve <token>` or `deny <token>` in that personal
conversation. Approval grants one native permission decision; it does not grant
future tool requests. Another permitted human, another conversation, a channel,
quoted chat text or an agent's rank cannot supply that decision. Approval
commands are handled by the control path and never forwarded as model prompts.
Only the action name and decision token are sent to chat; raw tool arguments
and provider errors are withheld.

Notification state is durable. A failed notification or a restart before its
confirmed delivery retries the same unconsumed token, after rechecking the
pending native request, input ownership, human, conversation and permission
details. A duplicate notification carries the same one-use token. If an unused
token expires while that exact request is still pending, Stargate issues a fresh
token and invalidates the old one. Changed requests or owners cannot renew it.

Tokens are consumed durably before submitting the native API decision, so a
retry after an uncertain API outcome cannot approve twice. The approval store
survives reopen, but every check is repeated: a token is useful only while the
same native request and running input remain valid and unexpired. Normal
gateway recovery can mark interrupted execution uncertain; check that outcome
instead of replaying the request. Do not delete the database to unblock a
permission. Consumed tokens, including uncertain API outcomes, are never renewed
or offered again even if the native request still appears pending.

## Screenshots

An agent can deliberately publish a local screenshot in its reply with a file
marker, for example `![Result screenshot](file:///srv/exports/agent/result.jpg)`.
Use a canonical, absolute path below a dedicated export directory shared with
the gateway's publishing group. Keep its parent paths non-hidden and expose only
the files intended for publication. Do not widen access to a whole home,
repository or credential directory. Stargate's prepared-file checks validate the
path and file identity before reading the bytes; the Teams image adapter reads
no filesystem paths itself.

Teams accepts PNG, JPEG, WebP and GIF sources up to 10 MiB. PNG and JPEG images up to 22,000 bytes and 1024 pixels per edge retain their original encoding.
For other supported images Stargate prepares a still JPEG preview, preserving the aspect
ratio. Source images can be up to 10 MiB and 4096 pixels per edge. The preview
is at most 1024 pixels per edge and 22,000 bytes. Stargate checks the full activity,
including its caption and reply metadata, against the Teams 80 KB budget.
The gateway can reduce the longest edge to 256 pixels to fit the preview byte limit. Up to two native decoders run at once. GIF previews show the first frame. Animated PNG and animated WebP are refused. JPEG previews flatten transparency. A busy decoder can retry before publication.
Images are never truncated or
silently replaced by their captions. No arbitrary image URLs are fetched, and
no extra public file endpoint is needed. Paste a screenshot into a Teams message for the officer to inspect. The registration option `incomingImages: false` disables incoming screenshot downloads. In groups and channels, mention the bot unless the conversation has opted into messages without a mention. Stargate downloads inline images from the authenticated Bot Connector for the admitted turn. PNG, JPEG, WebP and GIF can be up to 10 MiB each, 25 MiB total, and 4096 pixels per edge. HTML image sources and links to files in Microsoft 365 are separate from inline images.

The local encoded receipt stays in private delivery state. Publication uses the
original authenticated conversation and reply activity with a fresh access
check. The core saves the publication attempt before sending. If delivery is
uncertain or the process stops before recording success, a retry marks the image
unavailable and reports it once instead of publishing it again. Check the
conversation before choosing to publish a new image; an unavailable outcome
does not prove the earlier image never arrived.

### Receive documents in personal chats

To enable document receipt, set `attachmentFileHosts` on the Teams registration
to up to four exact, lowercase SharePoint hosts owned by its configured tenant,
for example `["contoso-my.sharepoint.com"]`. Omit the setting or use an empty
list to keep document receipt off. Use the actual host in the Teams download
URL. The Teams manifest needs a personal bot scope and `supportsFiles: true`.
Installers can require the `teamsAttachmentFiles: 1` officer-tools contract
marker when the host list is nonempty to detect releases that can read it.

Attach a PDF, UTF-8 plain text, Markdown, CSV or JSON file to a personal message.
The limit is 10 MiB per file and 25 MiB total across all attachments in the
message. Stargate passes the file bytes to the backend with a generated name.
Use a backend that accepts the selected file type. Pasted inline screenshots
continue to use the Bot Connector.

Stargate uses the registration's managed identity to request a file token
for the exact configured download host. It checks the file tenant against the
authenticated activity's tenant, sends the supplied URL verbatim, and declines
redirects. The operator must verify that each listed host belongs to the configured
tenant. Download URLs stay in memory and are valid for at most two minutes
from receipt. Queued requests can outlive that window. A gateway restart
also clears the download references. While document receipt is enabled,
Stargate reports attachments that exceed a limit, cannot be retrieved, or
arrive in a shared conversation as unavailable and asks the user to retry.

Microsoft makes the read-only `File.ReadSelected.User` resource-specific
consent permission available on 15 January 2027. Include that permission in
the Teams manifest by 1 March 2027 for continued document receipt. See
[Microsoft's bot file authentication guidance](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4#authenticate-bot-file-requests).

## Fleet roles and commissioning

An optional `fleetPolicy` can describe a rear admiral, captain or crew member,
its assigned checkout and permitted capabilities. A rear admiral is an agent:
its rank never supplies human approval authority. Teams proves the source
human from authenticated activity; an IRC agent remains an agent when its
request reaches the same pinned backend. Assigned-checkout instructions are
an operating rule, not a filesystem sandbox.

Before publishing a callback hostname, test valid delivery, wrong issuer and
audience, expired/forged tokens, service-URL/channel mismatch, excluded humans
and tenants, duplicate delivery, restart behaviour and source-specific replies.
For opt-in approvals, also test another human/conversation, expiry, changed
native input, replay and a permission requested through another transport.
Verify the reverse proxy exposes only the callback and that backend and
operator listeners retain their own authentication and local-user restrictions.
See [configuration](configuration.md), [operations](operations.md),
[IRC](irc.md) and [CLIProxyAPI](cliproxyapi.md) for the neighbouring components.

## Fleet result continuations

Opt-in `fleetControl.results` on the related IRC gateway can return a captain's
settled native outcome through the original Teams conversation and reply
activity. The durable dispatch retains the original authenticated job/native
input. Result delivery does not use the latest Teams conversation on a shared
pin, so an intervening human request cannot redirect it. See the
[fleet result protocol](fleet-tools.md).

The continuation is model-visible agent context (`s=fleet`), with the real
captain and reported native maker/model. The original human is retained only
as the delivery recipient for current access checks. Teams never offers a
human permission decision for this input, and an earlier human's permission
token cannot authorise it. Source evidence and rank remain separate from
human approval. Unknown or interrupted work is reported as uncertain without
repeating the assignment.

## Typing and progress

Teams registrations show typing and short status updates for a recent human
request by default. Set `livePresence: false` on a registration to disable them. The update is anchored to that
message. OpenCode reasoning, tool and reply events select fixed labels such as
“Thinking”, “Using a tool” and “Writing a reply”. The first text reply for that request closes
the stream.

The generic “Thinking” and “Working” labels give way to the shared
[waiting phrases](waiting.md), such as “Adama is pondering…”, after the
registration's `waiting.delayMs`. The name comes from the registration's
`displayName`, then its OpenCode agent ID, then its `id`. The phrase changes
at most once per `waiting.intervalMs`, on the next presence refresh (about
every three seconds), and is sent only when it changes. Every other label,
including “Using a tool”, “Writing a reply”, “Queued”, the waiting labels
and “Connection interrupted”, stays as it is. `waiting.delayMs: null` keeps
the generic labels. A captain's waiting override applies as it does in Slack,
and is read when the turn starts. Image-only replies use normal attachment delivery. Feedback stops
when the turn ends or after ten minutes. Where informative updates are unavailable, Teams receives a typing
activity while the turn runs.
