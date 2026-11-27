# Agent dispatch

Agent dispatch tells a fleet's captains about Subspace issues that are theirs
to pick up. It is a deterministic dispatcher in the rear admiral's gateway:
Stargate polls the Subspace API, keeps a private ledger of what it has sent,
and writes requests to the fleet's command and ship channels on IRC. No model decides
whether a message goes out. It is off unless `agentDispatch.enabled` is
`true`.

Fleet owns the [dispatch implementation](../src/coordination/fleet/dispatch/start.ts)
under `src/coordination/fleet/dispatch/`.

## What it does

1. **Assigned to a captain.** With `assignmentRequests` configured, the rear
   admiral asks a captain to take their Backlog or Todo issue in the captain's
   ship channel. The captain's gateway first checks for an idle crew member
   with no queued work and no usage cooldown. The request asks the captain
   to reply in its thread and move the issue to In Progress when work starts.
   A still-waiting issue is eligible for a reminder after four hours, when
   crew are available again. That includes assigned trackers in Backlog or
   Todo. The rear admiral leaves at least five minutes between requests to
   the same captain. Assignments to crew, the rear admiral or people are skipped.
2. **Ready for agents.** When an unassigned issue in this fleet is flagged
   _Ready for agents_, the rear admiral offers it to the captains one at a
   time. Each captain has `answerTimeoutSeconds` (default 5 minutes) to accept
   or decline; no answer counts as a decline. When a full round ends with no
   acceptance, the next round starts after 1 hour, then 3, 6 and 12 hours,
   each measured from the end of the previous round. After the last round
   the rear admiral comments on the issue that no captain could take it,
   clears _Ready for agents_ and says so in the channel. Flag the issue again
   to retry.

Ready for agents offers and their outcomes remain visible in fleet command.
Ship channels carry the passive capacity check as a
`+stargate/assignment-capacity` TAGMSG. An authenticated captain's gateway
answers with a `yes` or `no` tag carrying the probe nonce. The check starts
no agent turn. Upgrade the captains with the rear admiral so the crew plugin
can answer. A request with an uncertain server receipt waits until its next
reminder window before it can repeat.

## Decision outcomes by direct message

Set `agentDispatch.decisionOutcomeDms` to `true` when the Subspace API
serves the decision outcome feed. The default is off. It works without
`agentDispatch.enabled`, which switches on issue dispatch. The dispatcher sends
each accepted or rejected proposal to the active captain who recorded it.
It checks that the fleet roster's `ircNick` matches the operator's configured
captain account and confirms who holds that account before sending. For fleets
where an agent name differs from its IRC account, set `captainAccounts`.
The DM contains only the decision reference and outcome, for example
`D-00042-NAV was accepted.`

The captain must admit the sender as a fleet peer and have capacity under
`access.peerTurnsPerHour`. With `dmPolicy: "redirect"`, set the captain's
`decisionOutcomeSender` to the rear admiral's IRC account. The captain will
admit only marked decision DMs from that authenticated account as the
exception to redirect. Normal captain DM intake
starts the turn. The server echo confirms the IRC send. The captain's
gateway can still decline the turn under its admission policy. Unreachable
captains remain pending. The dispatcher acknowledges delivery to the API
after a server echo and retains a local receipt if the API is unavailable.
A loss of the IRC confirmation can cause a retry. Captains use the decision
reference to read the authoritative outcome.

The API feed is `GET /api/v1/fleets/{fleetId}/decision-outcomes` with
`limit` and optional `cursor`. It returns an `items` page with `id`,
`identifier`, `recordedByUserId` and `status` for each pending outcome.
After delivery, the dispatcher calls
`POST /api/v1/fleets/{fleetId}/decision-outcomes/{id}/delivered`. The API
must scope both routes to the authenticated fleet dispatcher and return an
empty 204 on every successful receipt, including repeated calls.

## How it fits

- **Rear admiral only.** It runs on the IRC registration named by
  `messaging.registration`, which must have `fleetPolicy.role: "rear_admiral"`.
  Captains need no `agentDispatch` section; they answer with a tool, and
  recognise their rear admiral from their existing fleet configuration (see
  [peer turn limits](#peer-turn-limits)).
- **Outbound only.** Stargate calls the Subspace API; the API never calls
  Stargate, and nothing new listens on the fleet VM. Requests use HTTPS, or
  HTTP to a loopback address, and never follow redirects. Stargate does not
  check that the route is private: point `api.baseUrl` at a private address,
  an SSH or WireGuard tunnel, or a zero-trust access route (see
  [extra headers](#credentials)). Never expose the API to make this work.
- **Identity from the API.** Stargate never identifies an agent by name. At
  start it reads `GET /api/v1/me` with the configured credential and goes on
  only when that identity is an agent of rank `rearAdmiral` whose `fleetId`
  is this fleet's ID from the roster; an agent without a fleet is refused.
  Nothing is written to the API until the running process has confirmed
  this. An answer that arrives first, as after a restart, is recorded and
  confirms the identity before its assignment; when that fails, the
  assignment waits in the ledger for a poll that confirms it.
  Captains are the fleet's agents of rank `captain` in the fleet roster.
- **Messaging.** IRC is the only messaging system today
  (`messaging.type: "irc"`). The IRC server must offer `message-tags` and
  `echo-message`, besides the SASL and `account-tag` that Stargate always
  needs.

## Configuration

A top-level `agentDispatch` object. Every change needs a restart; a reload
that changes it is refused as restart-only.

```json
{
  "agentDispatch": {
    "enabled": true,
    "fleet": "example-fleet",
    "api": {
      "baseUrl": "https://subspace.internal.example",
      "tokenEnv": "STARGATE_SUBSPACE_DISPATCH_TOKEN",
      "headersEnv": {
        "CF-Access-Client-Id": "STARGATE_SUBSPACE_ACCESS_ID",
        "CF-Access-Client-Secret": "STARGATE_SUBSPACE_ACCESS_SECRET"
      }
    },
    "messaging": {
      "type": "irc",
      "registration": "fleet-admiral",
      "channel": "#example-command"
    },
    "captainAccounts": { "example-captain": "example-captain-irc" },
    "assignmentRequests": {
      "reminderSeconds": 14400,
      "shipChannels": { "example-captain-irc": "#example-ship" }
    },
    "pollIntervalSeconds": 120,
    "answerTimeoutSeconds": 300,
    "retryLadderSeconds": [3600, 10800, 21600, 43200]
  }
}
```

`assignmentRequests.shipChannels` maps authenticated IRC accounts to ship
channels. The rear admiral must join those channels. The reminder interval
is configurable from 3,600 through 604,800 seconds. Use
`"assignmentRequests": null` to disable assigned work requests while keeping
Ready for agents. Omitting the setting preserves one-time command-channel
notices for existing configurations.

Set `readyOffers: false` to run assigned work requests without starting
or continuing offers for unassigned Ready for agents issues. Existing offers
and their timers remain dormant and resume if you re-enable Ready for agents.

For an enrolled fleet, set `api` to
`{ "socketPath": "/run/example/rear-admiral/api.sock" }` using the rear
admiral's existing `subspaceAgents` signing proxy. The proxy signs each
request with the enrolled identity. Bearer and header environment settings
apply to direct API connections.

To give decision delivery a separate connection, enable `decisionOutcomeDms`
and set `decisionRelay` to `{ "socketPath": "/run/example/decisions/api.sock" }`.
With issue dispatch enabled, `api` supplies the issue connection and both
connections must authenticate as the same rear admiral. For decision delivery
alone, set `enabled: false` and omit `api`. With no `decisionRelay`, decision
outcomes use `api` as usual.

Use a normalised absolute path. If the relay runs as a different user, its
socket directory and socket must use the gateway's dedicated primary group.
The directory must belong to root or to the socket owner. Its ancestors
must belong to root or the gateway user, and group or other write access
requires a sticky directory. The socket directory forbids group write
access, and both directory and socket forbid access for other users.
Stargate checks the socket before each request. Configure the relay to allow
only the identity and fleet lookup, outcome feed and delivery receipt routes
for this fleet.

The officer-tools manifest advertises `decisionOutcomeDms: 1` for installers
that commission the gateway's decision outcome delivery capability.

| Key                        | Default                                     | Meaning                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                  | `false`                                     | Enables issue dispatch. With both `enabled` and `decisionOutcomeDms` off, the gateway opens no ledger, registers no listener and makes no API requests.                                                           |
| `fleet`                    | Required                                    | The fleet's slug or UUID in the Subspace API.                                                                                                                                                                     |
| `api.baseUrl`              | Direct mode only, required                  | API origin, optionally ending in `/api`. HTTPS, or HTTP on loopback, with no credentials, query or fragment. Routes are under `/api/v1`.                                                                          |
| `api.tokenEnv`             | Direct mode only, required                  | Name of the environment variable that holds the rear admiral's bearer token. Never the token itself.                                                                                                              |
| `api.socketPath`           | Socket mode only, required                  | Absolute path to the signing socket.                                                                                                                                                                              |
| `decisionRelay.socketPath` | Omitted                                     | Absolute path to a separate relay for decision outcomes.                                                                                                                                                          |
| `api.headersEnv`           | `{}`                                        | Extra request headers for a private access layer: header name → environment variable name. `Authorization`, `Accept`, `Content-Type`, `Content-Length`, `Host`, `Connection` and `Transfer-Encoding` are refused. |
| `messaging.type`           | `"irc"`                                     | The messaging system. Only `irc` is accepted.                                                                                                                                                                     |
| `messaging.registration`   | Required                                    | ID of the rear admiral's IRC registration (`fleetPolicy.role: "rear_admiral"`).                                                                                                                                   |
| `messaging.channel`        | That registration's `fleetChannels.command` | The command channel. It must be one of the registration's channels.                                                                                                                                               |
| `captainAccounts`          | `{}`                                        | Subspace agent name → IRC account, for a captain whose chat account differs from its agent name. An unlisted name is its own account.                                                                             |
| `pollIntervalSeconds`      | `120`                                       | Seconds between polls, 30–3600.                                                                                                                                                                                   |
| `answerTimeoutSeconds`     | `300`                                       | Seconds each captain has to answer an offer, 60–3600.                                                                                                                                                             |
| `retryLadderSeconds`       | `[3600, 10800, 21600, 43200]`               | Waits between rounds, each 60–604800, at most 10 entries. There is one more round than entries; `[]` means a single round.                                                                                        |

A captain is addressed only when its IRC account is in the rear admiral
registration's `fleetPolicy.agentAccounts`; Stargate logs once and skips a
captain that is not. `stargate config check` checks the credentials for the
selected API connection.

## Credentials

The dispatcher calls the API as the rear admiral, so assignments, comments
and flag changes are recorded as the rear admiral's. When the rear admiral
is enrolled, point `api.socketPath` at its signing proxy on this gateway.
Stargate rechecks the identity before writes in socket mode.

For a direct API connection using a bearer token, provision on the fleet VM:

1. **A registered API agent identity** for the rear admiral: rank
   `rearAdmiral`, linked to this fleet so that `GET /api/v1/me` returns its
   `fleetId` (`POST /api/v1/agents`, by an organisation administrator).
2. **A bearer token for that identity that stays valid**, either long-lived
   or refreshed by something outside Stargate, in the variable named by
   `api.tokenEnv`: in the service environment or the private
   `<config>.env` companion (mode 0600). Stargate reads it from its process
   environment, which is fixed for the life of the process, so a replaced
   token takes effect after a restart. Stargate has no sign-in or refresh
   flow of its own, and a person's short-lived sign-in token stops working
   when it expires.
3. **Network reach** from the gateway's OS user to the API. A default
   single-VM fleet may let only root and the operator reach the API port;
   allow the gateway's service user, or give it a private route it can
   reach.
4. **Optional private-access headers.** When the API sits behind a
   zero-trust access layer, list each header in `api.headersEnv` with the
   variable that holds its value, for example a service token's client ID
   and secret. The values are sent on every request and never logged.

When the API refuses the credential (HTTP 401 or 403), Stargate logs one
plain warning with the status, not the token, and tries again at each poll
interval; nothing else is attempted and nothing crashes. When the token works
but `GET /api/v1/me` is not this fleet's rear admiral, dispatch stays idle
and logs that once.

## What is polled

Every `pollIntervalSeconds`, after the first poll at start:

- the fleet roster (`GET /api/v1/fleets/{fleet}`): captains and whether the
  API marks each available;
- issues assigned to those captains. Legacy notices scan recent changes,
  overlapping the last scan by five minutes. Capacity-aware requests scan
  assigned Backlog and Todo issues, including trackers, so they can send reminders;
- unassigned issues flagged for agents (`readyForAgents=true&assignee=none`),
  kept when their project's initiative, or that initiative's nearest ancestor
  with a fleet, belongs to this fleet;
- initiatives and projects, for that fleet membership, read again whenever
  the last read is older than one poll interval;
- any issue under an open offer that the ready list no longer shows, read on
  its own.

Each poll reads at most 50 pages (of 100 issues) of an issue list. A longer
list goes on from the API's cursor at the next poll, so no list is too long
to make progress. The ledger keeps the legacy assignment cursor across
restarts. The Ready list and capacity-aware scans start at the first page after
a restart. Request timestamps persist, so a restart does not reset reminder
intervals. Initiatives and projects are read whole, up to 500 pages each; a longer
list leaves fleet membership unknown, which holds offers (see below).

## Offers and answers

The first captain asked moves on by one for each new flagged issue, so the
same captain is not always first. Captains are asked in a fixed order from
there. A captain is skipped when the API marks it unavailable, its chat
account is not enrolled, or it is not online under its account. Before each
offer the issue is read again; an issue that has been assigned, unflagged,
closed, archived or moved out of the fleet ends the offers. If that happens
while an offer is open, the offer is withdrawn in the channel. Fleet
membership must be known and no older than one poll interval before an
offer is sent and before the acceptance write; it is read again when it is
not. When it cannot be read, the step waits for a later poll: unknown
membership never lets an issue through.

On acceptance the rear admiral assigns the issue to that captain with one
versioned write; the API clears _Ready for agents_ in the same write. A
version conflict re-reads the issue and tries again. If someone else took
the issue first, the offer closes and the channel is told. A failed
assignment write is retried at each poll and reported once in the channel.

The user ID stored with the offer is not trusted on its own. Before each
assignment attempt, the first and every retry, the rear admiral checks the
fleet roster, read again when it is older than one poll interval, as for
fleet membership: the user must still be an agent of rank `captain` in this
fleet, and its chat account must still be the account that answered. The
API's availability flag is not checked here. When either check fails, the
offer is closed as declined, the channel is told why (a `withdrawn` line)
and the next captain in the round is asked. A roster that cannot be read
holds the write until a later poll.

Captains answer with the `fleet_answer_offer` tool from the
[fleet plugin](fleet-tools.md), never by Stargate reading chat text:

```json
{
  "offerID": "offer-0123456789abcdef",
  "answer": "accept",
  "reason": "Free now"
}
```

The captain's gateway accepts only an offer that its own authenticated IRC
intake recorded for its account, sends one answer per offer (repeating the
same answer sends nothing; a different answer is refused) and reports an
unconfirmed send so the captain checks the channel before answering again.
`reason` is optional, at most 200 characters, and only shown to people. The
`fleet_answer_offer` permission is part of the captain role's provisioned
fleet permissions; also allow it in the captain's `backend.permissions`,
which the gateway applies to every fleet call. The tool needs a captain IRC
registration with an OpenCode backend, a pinned `sessionID`, `fleetControl`
and the fleet plugin loaded.

## Chat format

Every dispatch line but the issue title line carries the client tag
`+stargate/dispatch=<kind>,<value>`.
The tag is for programs; the text is for people and can change. As with
[request progress tags](irc.md#request-progress-tags), a client must check
the server's authenticated `account` tag before acting on a marker.

| Kind                                                    | Sent by       | Command   | Value            | Notes                                                                                             |
| ------------------------------------------------------- | ------------- | --------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| `assigned`                                              | Rear admiral  | `PRIVMSG` | Issue identifier | Behaviour 1, addressed `@<captain nick>:`. Fixed text from the marker, never the title.           |
| `offer`                                                 | Rear admiral  | `PRIVMSG` | Offer ID, issue  | Behaviour 2, as above. Its server `msgid` identifies the offer in chat.                           |
| None                                                    | Rear admiral  | `NOTICE`  | None             | The issue title for people, after each request; for an offer, `+draft/reply=<offer msgid>`.       |
| `accept`, `decline`                                     | Asked captain | `NOTICE`  | Offer ID         | `+draft/reply=<offer msgid>`. Counted only from the asked captain's account, before the deadline. |
| `accepted`, `timeout`, `withdrawn`, `taken`, `retrying` | Rear admiral  | `NOTICE`  | Offer ID         | Status for people, replying to the offer.                                                         |
| `gave-up`                                               | Rear admiral  | `NOTICE`  | Issue identifier | After the last round.                                                                             |

The `offer` value is `<offer ID>,<issue identifier>`, for example
`offer,offer-0123456789abcdef,PRJ-12`; every other value is one field.
The captain's nick is the one the server shows holding the captain's account
at that moment. Offer IDs are `offer-` and 16 hexadecimal digits. A refused
acceptance (see [offers and answers](#offers-and-answers)) is a `withdrawn`
line that names the reason.

An issue title is user-editable, so it never becomes a captain agent's
instruction. The request `PRIVMSG`, the only line that can start a captain's
turn, carries only fixed text built from the marker's fields: the address,
the issue identifier, the offer ID, the request and how to answer. The title
follows for people as a separate `NOTICE`, which never starts a turn, on one
line, without control characters, cut to fit the line. It is best effort: a
title line that cannot be sent is logged and neither fails nor repeats the
request. Answers reply to the `PRIVMSG`, never to the title line. As defence
in depth, for a request from its rear admiral the captain's gateway also
rebuilds the agent's turn from the marker, with a note that issue content is
untrusted data and that the agent should read the issue itself.

```text
<rear-admiral> @example-captain: PRJ-12 is ready for agents. Can you take it? Call fleet_answer_offer with offerID offer-0123456789abcdef to accept or decline within 5 minutes. No answer counts as a decline.
-rear-admiral- Title of PRJ-12: “Fix the flaky upload test”
-example-captain- Accepting offer offer-0123456789abcdef: Free now
-rear-admiral- example-captain accepted offer offer-0123456789abcdef: PRJ-12 is now assigned to example-captain.
```

## Peer turn limits

`access.peerTurnsPerHour` limits turns that peer captains start on a captain.
The rear admiral's dispatch request is never dropped by it: an `assigned` or
`offer` message whose server-authenticated account is the captain's rear
admiral is admitted even when the peer budget is used up. It still counts as
a peer turn, so a busy dispatch hour leaves less budget for other peer
messages in the command channel. Answers and status lines are `NOTICE`s,
which never start a turn, so they use no budget. The rear admiral counts an
answer only when its sender and channel pass the rear admiral registration's
own IRC access rules (`deniedAccounts`, `deniedChannels`, `allowedAccounts`,
fleet policy) in a channel it has joined. The dispatcher bounds its
own volume: at most one open offer per issue, and one assignment notice per
(issue, assignee).

A captain recognises its rear admiral from its existing fleet configuration:
an account in `fleetPolicy.agentAccounts` that is also a
`fleetControl.targets` entry with `role: "rear_admiral"`. Only that account's
requests pass the peer limit, get the turn described under
[chat format](#chat-format) and, for an offer, are recorded for the answer
tool. When the captain has `fleetChannels`, an offer is recorded only in its
`fleetChannels.command` channel. The same markers from any other account,
an enrolled peer captain included, are ordinary peer messages: they count
against the limit, record no offer and reach the agent as written.

The rear admiral must also be one of the captain's peer captains for its
requests to be admitted at all. With the
[configured fleet defaults](irc.md#configured-fleet-defaults), list the rear
admiral's account in the captain's `fleetPolicy.agentAccounts` and as a
`fleetControl.targets` entry with `role: "rear_admiral"`, and leave
`access.peerCaptains` unset.

## Restarts and failures

The ledger is `<dataDirectory>/agent-dispatch.sqlite`, private to the rear
admiral's gateway.

- **First start.** The first read of the captains' assignments records them
  without sending anything. A list longer than one poll reads is recorded
  over several polls, and assignment notices start when it ends. Issues
  already flagged for agents are offered meanwhile.
- **Restart.** Notified (issue, assignee) pairs, the assignment cursor, the
  place in an unfinished assignment list and each offer's round, captain,
  deadline and next round time survive a restart. The API identity, the
  fleet roster and fleet membership do not: each is read again before the
  next write. Each step is recorded before the message it leads to, so a restart
  never asks twice; a stop between the record and the send leaves an offer
  that times out. A deadline that passed while Stargate was down is handled
  at the first poll.
- **Answers while the rear admiral is offline** count only if the server
  replays them with their original time, within the deadline; otherwise the
  offer times out.
- **API failures** (no connection, a timeout, a server error, an unreadable
  answer or a refused credential) never crash the gateway. Each is logged
  once with its HTTP status only, and the failed step is tried again at the
  next poll, never sooner. A write whose 2xx answer cannot be read counts as
  done; a write whose answer is lost is checked by reading the issue again.
- **Chat failures.** When the rear admiral's own IRC connection or command
  channel is unavailable, an offer is held for the same captain; no captain
  is skipped and no round is used up.
- **Identifiers a marker cannot carry.** An issue whose identifier does not
  fit the [marker](#chat-format) is never sent untagged. Its assignment
  notice is skipped, and a ready issue is not offered until the issue
  changes; each is logged once, and other issues are not held.

## Limits

- One fleet per gateway, on IRC only.
- An older Subspace API without `readyForAgents`: only assignments are
  announced, and one log line says that round robin offers are unavailable.
  A restart picks up an upgraded API.
- Only a captain on OpenCode with a pinned session, `fleetControl` and the
  fleet plugin can answer; offers to any other captain time out.
- An answer arriving after the offer's message ID could not be confirmed
  (no `echo-message` echo in time) cannot be matched and the offer times out.
- A lost answer to the give-up comment can repeat the comment. Stargate
  never claims exactly-once external effects.
- A busy command channel shares the captains' peer turn budget, as above.
- An issue title is quoted as written in its `NOTICE`; a title that
  mentions a nick can catch a person's attention, but never starts an agent
  turn. A captain whose `fleetControl` does not name its rear admiral treats
  dispatch requests as ordinary peer messages (the fixed text, no title) and
  cannot answer offers.

## Tests

`tests/agent-dispatch.test.ts` drives the dispatcher with a fake API, chat
and clock, including the fixture evidence: a direct assignment notified once,
a flagged issue accepted by the second captain, a flagged issue nobody takes
ending in the comment and the cleared flag (with a shortened ladder), and a
restart mid-offer. `tests/agent-dispatch-api.test.ts` runs the real API client
against a fake API with injected failures. `tests/agent-dispatch-wiring.test.ts`
covers configuration, the off switch, the captain's recognition of its rear
admiral, the captain's answer tool and an end to end run over a local IRC
fixture. No test contacts a real service.
