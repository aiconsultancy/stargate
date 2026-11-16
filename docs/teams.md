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
personal message; a channel or group chat must also match `access.channels`.
For channel messages, the channel ID in `channelData.channel.id` is the access
scope even when the activity's conversation ID is different. Denied users and
channels override the allow lists. Wildcards are not supported for Teams.
Registration IDs and socket paths must be unique within the gateway.

The activity must identify the configured tenant. If it carries tenant IDs in
both conversation and channel data, both must agree. Bot senders, self messages,
missing human object IDs and unsupported activity types are refused. Access is
checked again before work and delivery; removing a permitted channel also
blocks replies to its previously stored conversation references.

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

Teams supports bounded inline PNG and JPEG screenshots here. The adapter checks
signatures, framing, PNG chunk checksums and dimensions, rejects animation and
unsupported types, and accepts at most 1,000,000 input bytes and 1024 pixels in
each direction. The complete encoded activity, including base64, caption and
reply metadata, must fit the 80 KB Teams safety budget in both UTF-8 and UTF-16.
This often requires a smaller JPEG or a crop. Images are never truncated or
silently replaced by their captions. No arbitrary image URLs are fetched, and
no extra public file endpoint is needed. Incoming attachment downloads remain
unsupported.

The local encoded receipt stays in private delivery state. Publication uses the
original authenticated conversation and reply activity with a fresh access
check. The core saves the publication attempt before sending. If delivery is
uncertain or the process stops before recording success, a retry marks the image
unavailable and reports it once instead of publishing it again. Check the
conversation before choosing to publish a new image; an unavailable outcome
does not prove the earlier image never arrived.

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
