# IRC transport

Stargate can reach a captain over IRCv3 as well as Slack. One process can run
Slack bots and IRC registrations together; neither depends on the other.
An IRC registration has its own connection, access rules, queue namespace
and delivery. It reuses the gateway's SQLite queue, outbox, delivery
cursor, transcript catch-up and no-replay rules.

Stargate does not start, configure or administer the IRC server. Account,
channel and TLS setup belong to the server operator.

## One bot with no Slack app

Create a SASL account for the bot and make sure it can join a test channel.
The example uses password authentication over TLS, an allowlist of IRC
accounts, and a Pi Durable backend with a direct OpenAI API key. Save the
configuration as `stargate.json` and replace the host, account, channel, and
working directory with your own values.

```json
{
  "irc": [
    {
      "id": "project-helper",
      "server": { "host": "irc.example.net", "port": 6697, "tls": true },
      "account": "project-helper",
      "passwordEnv": "STARGATE_IRC_PASSWORD",
      "channels": ["#agents"],
      "access": { "allowedAccounts": ["your-account"], "allCallWords": [] },
      "backend": {
        "type": "pi-durable",
        "directory": "/srv/projects/example",
        "model": "openai/gpt-5",
        "tools": "none"
      }
    }
  ]
}
```

Put `STARGATE_IRC_PASSWORD` and `OPENAI_API_KEY` in the private
`stargate.json.env` file (mode `0600`). If the server uses a private CA, set
`server.caFile` to the CA certificate path. Validate and start from the
[Stargate directory](../README.md#install):

```sh
bun run src/main.ts config check
bun run src/main.ts start
```

Sign in as the allowed account and send the bot a direct message asking it to
reply "Stargate is ready" without using tools. See [access rules](#access) for
channel requests and team behavior.

## Operator steps

1. On the IRC server, create one SASL account for the captain and one per
   crew member (Ergo: `/NICKSERV SAREGISTER <name> <password>` as an
   operator). Register the ship channel with the captain as founder.
2. Put each password in `<config>.env` (mode `0600`) under the variable
   named by its `passwordEnv`. A certificate-authenticated captain uses
   `clientPemFile` instead. Crew may also use their own per-account
   `clientPemFile`. Never put a password or a private key in
   `stargate.json` or chat.
3. Add the `irc` registration. For a captain that is also on Slack, copy
   the Slack bot's OpenCode `url`, `directory`, `agent` and `sessionID`;
   the pinned session must match that directory and agent.
4. Optional: give crew a lasting invite exception on an invite-only ship
   channel (see [channels](#channels)); otherwise the captain invites them.
5. Optional: create the [DM audit](#dm-audit) channel.
6. Run `stargate config check --config <path>`, then restart for connection changes.
   Access/transcription and IRC crew additions/idle removals can use
   [SIGHUP reload](configuration.md#reload-configuration-without-restarting).
7. Regenerate or edit the captain definition so it contains the
   "IRC messages" paragraph (see [captain instructions](#captain-instructions)).

## Server expectations

Stargate is tested against [Ergo](https://ergo.chat) 2.19. Any IRCv3 server
works if it offers these capabilities:

| Capability                        | Need        | Use                                              |
| --------------------------------- | ----------- | ------------------------------------------------ |
| `sasl` (PLAIN or EXTERNAL)        | required    | Log in to the configured account                 |
| `account-tag`                     | required    | Identify every sender by account                 |
| `message-tags`, `server-time`     | recommended | Message IDs, reply tags, times                   |
| `batch`, `labeled-response`       | recommended | Confirm each sent line                           |
| `echo-message`                    | recommended | Own message IDs for reply triggers               |
| `account-notify`, `extended-join` | optional    | Nick hints for direct replies; WHOIS confirms    |
| `draft/chathistory`               | optional    | Fetch channel messages missed during a reconnect |

Without the configured SASL mechanism or `account-tag`, Stargate refuses the server and retries
after five minutes. Without `labeled-response`, a line counts as sent when
it is written to the socket.

Every account must log in with SASL. Stargate never creates accounts. With
Ergo, `force-nick-equals-account` keeps each nick equal to its account, and
`multiclient` lets a reconnect take over the nick.

### Optional features

With the default turn-status setting, fleet captains and rear admirals send an IRC notice when they start a verified
human request. After five minutes, a notice shows the latest confirmed stage
for that request. On OpenCode, Stargate checks every five minutes and reports
new observations. A stage describes an observed event, which may have
happened earlier in the turn. Notices can report submission, queueing,
delivery, model steps, reasoning, tool calls and public replies. They contain
only the stage and time. A timeout includes the last observation or reports
that activity could not be confirmed. Other backends send a single notice
if the request is still open after five minutes. The default request limit
remains one hour.
Before submitting another verified human request, Stargate checks for an
unanswered OpenCode question in the active session. When it finds one, it
reports the blocker without exposing or answering the question. Answer from
the original conversation or resolve the form in OpenCode, then resend the
new request. If the check is unavailable, normal submission continues.

Progress notices identify the triggering message where supported. They replace
continuous typing for these registrations and cannot wake other agents.
Finishing, cancelling or timing out the turn stops ongoing status notices. Use
`features.turnStatus: false` to use the original typing behaviour instead.

Captains tag or dispatch a rear admiral for a specific action, a decision
within that role or cross-ship coordination. Put routine progress and review
results on the issue. Rear admirals skip peer FYIs that require no action and
reply once to an actionable request. Formal assignments use their correlated
results. The gateway still wakes an explicitly tagged visitor.

`features.steerThreadFollowUps` defaults to `false`. When enabled, an admitted
text reply in the exact active captain thread can steer its running OpenCode
input instead of creating another queued turn. Another thread stays queued;
definite native refusal falls back to the same queue. Stop and clarification
controls stay separate. It uses the same gateway admission and receipt rules
as [Slack follow-up steering](operations.md#follow-up-steering), not another
scheduler. Enabling it does not change any Slack registration's flag.

Stargate uses each of these only when the server offers it. A switch under
`irc[].features` turns one off; the protocol switches below default to `true`.
The separate [native clarification bridge](#native-clarification-questions),
`features.questions`, defaults on for OpenCode registrations with enrolled
humans and needs `message-tags`.

| Server offers                                                                   | Switch       | Stargate then                                                                                                                                                                                        |
| ------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `soju.im/FILEHOST` or `draft/FILEHOST` (ISUPPORT), or `server.filehostOverride` | `filesIn`    | Downloads FILEHOST links in admitted messages as attachments ([files](#files))                                                                                                                       |
| the same FILEHOST                                                               | `filesOut`   | Uploads published reply files and posts one link line each ([files](#files))                                                                                                                         |
| `draft/multiline` (with `batch`)                                                | `multiline`  | Sends each reply chunk as one batch within `max-bytes`/`max-lines`, continues long lines with `draft/multiline-concat`, and reads incoming batches as one message                                    |
| `message-tags` (client tags pass through)                                       | `typing`     | Sends `+typing=active` every 3 s while a turn runs and `+typing=done` before the reply, in channels and direct messages                                                                              |
| `message-tags` (`+draft/react`, `+draft/reply`)                                 | `reactions`  | Sends reaction replies as `+draft/react`; a person reacting with a `stopReactions` emoji (default ✋, 🛑) on a request or its bot answer stops the active turn ([Stop](#stop-by-reaction))           |
| `draft/chathistory` (with `batch`, `server-time`)                               | `catchUp`    | On each (re)connect replays missed channel messages (`AFTER`) and direct messages (`TARGETS`, then `AFTER`) from a cursor stored in SQLite, at most `catchUpHours` (24) back ([catch-up](#catch-up)) |
| `draft/persistence`                                                             | `alwaysOn`   | Sends `PERSISTENCE SET ON` after each connect: the server keeps the account in its channels and stores direct messages while Stargate is away ([presence](#presence))                                |
| ISUPPORT `BOT` (for example `BOT=B`)                                            | `botMode`    | Sets that user mode on its own nick (`MODE <nick> +B`) after each connect, so clients show the account as a bot                                                                                      |
| `draft/read-marker`                                                             | `readMarker` | Sends `MARKREAD <target> timestamp=<time>` after a message is accepted, so the account's other clients see it read                                                                                   |

## Configuration

Add an `irc` array beside `bots`. Either array may be empty, but not both.

```json
"irc": [
  {
    "id": "galactica-irc",
    "displayName": "Galactica",
    "server": { "host": "127.0.0.1", "port": 6667, "tls": false },
    "account": "galactica-captain",
    "passwordEnv": "STARGATE_IRC_GALACTICA_CAPTAIN_PASSWORD",
    "channels": ["#ship-galactica"],
    "access": {
      "deniedAccounts": [],
      "deniedChannels": [],
      "textMentions": ["all captains"],
      "allCallWords": ["all hands", "all crew", "everyone"],
      "peerCaptains": [],
      "shipTurnsPerAgentPerHour": 60,
      "allCallStaggerMs": 4000
    },
    "crew": [
      {
        "id": "chief",
        "account": "galactica-chief",
        "passwordEnv": "STARGATE_IRC_GALACTICA_CHIEF_PASSWORD",
        "channels": ["#ship-galactica"],
        "backend": {
          "type": "opencode",
          "url": "http://127.0.0.1:4096",
          "directory": "/srv/galactica/crew/chief",
          "agent": "galactica-crew-chief"
        }
      }
    ],
    "audit": { "channel": "#agent-dms" },
    "dmPolicy": "agent",
    "backend": {
      "type": "opencode",
      "url": "http://127.0.0.1:4096",
      "directory": "/srv/galactica/captain",
      "agent": "galactica-captain-adama",
      "sessionID": "ses_..."
    }
  }
]
```

| Field                          | Rule                                                                                                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.host`, `server.port`   | IRC server address                                                                                                                                                                                                                                      |
| `server.tls`                   | `false` only for `127.0.0.1` or `::1`                                                                                                                                                                                                                   |
| `server.caFile`                | Absolute PEM path of a private CA; TLS only                                                                                                                                                                                                             |
| `server.network`               | Optional ISUPPORT `NETWORK` name, for example `Fleet`; another name is refused                                                                                                                                                                          |
| `account`, `passwordEnv`       | Expected SASL account and, for PLAIN, the environment variable with its password                                                                                                                                                                        |
| `clientPemFile`                | Absolute path to the captain’s private certificate and key PEM for SASL EXTERNAL; TLS only, in place of `passwordEnv`                                                                                                                                   |
| `nick`                         | Optional; defaults to the account                                                                                                                                                                                                                       |
| `channels`                     | The only channels the captain joins and answers in; at most 20, each at most 50 bytes                                                                                                                                                                   |
| `access`                       | See [access](#access)                                                                                                                                                                                                                                   |
| `crew`                         | See [crew](#crew-on-irc); at most 20                                                                                                                                                                                                                    |
| `backend`                      | Any backend; OpenCode can pin the captain `sessionID`                                                                                                                                                                                                   |
| `concurrency`, `turnTimeoutMs` | IRC ship registration defaults to concurrency 4 and a 60-minute turn. Crew entries keep their own limits.                                                                                                                                               |
| `server.filehostOverride`      | Optional FILEHOST upload URL when the server does not advertise one ([files](#files))                                                                                                                                                                   |
| `features`                     | Switches for [optional features](#optional-features); protocol switches default to `true`, while `questions` defaults to `false`                                                                                                                        |
| `stopReactions`                | Emoji that stop a turn ([Stop](#stop-by-reaction)); default `["✋", "🛑"]`, at most 10, `[]` is off                                                                                                                                                     |
| `catchUpHours`                 | Longest [catch-up](#catch-up) window, 1–168 hours (default 24)                                                                                                                                                                                          |
| `transcription`                | Audio transcription for FILEHOST audio files, as for Slack bots ([files](#files))                                                                                                                                                                       |
| `audit`                        | Optional `{ "channel": "#agent-dms" }`: mirror every agent DM to that channel ([DM audit](#dm-audit))                                                                                                                                                   |
| `crewMessaging`                | `{ "sessions": false, "ircCopies": false }`: crew IRC sessions may use `stargate_dm`/`stargate_mail`; `stargate_dm` is also sent as an IRC DM ([crew sessions](#stargate_dm-and-stargate_mail-in-crew-irc-sessions), [copies](#stargate_dm-as-irc-dms)) |
| `dmPolicy`                     | `agent` (default: the captain answers DMs) or `redirect` ([DM audit](#dm-audit))                                                                                                                                                                        |

### Naming

The examples use this naming rule for a ship `<ship>`:

| Name                 | Rule             | Example             |
| -------------------- | ---------------- | ------------------- |
| Ship channel         | `#ship-<ship>`   | `#ship-galactica`   |
| Captain account/nick | `<ship>-captain` | `galactica-captain` |
| Crew account/nick    | `<ship>-<crew>`  | `galactica-chief`   |

Stargate does not enforce the rule: the server operator assigns names, and
peer captains stay an explicit list (see [peer captains](#peer-captains)).
The rule makes ship accounts easy to grant with one invite exception mask
such as `galactica-*!*@*`.

Put passwords in the private `<config>.env` companion or the service
environment, never in JSON. Every PLAIN account needs its own `passwordEnv`.
`stargate config check` validates the schema, checks that each password
variable is set and that `caFile` is a file. It does not connect.

For the TLS listeners, use the server's private CA:

```json
"server": {
  "host": "irc.example.net",
  "port": 6697,
  "tls": true,
  "caFile": "/home/operator/.local/state/ergo/tls/ca.pem"
}
```

Stargate verifies the certificate against that CA and the host name or IP.

For a captain using SASL EXTERNAL, link the client certificate to the
captain's account on the server and set `clientPemFile` instead of
`passwordEnv`. Use a regular file owned by the Stargate service user with mode
`0600` (or `0400`) and put the leaf certificate first if it has a chain.
`stargate config check` verifies ownership, private permissions and that the key
matches the certificate. Stargate requires the server to attest the configured
account during SASL and has no password fallback. Restart after rotating the
PEM. EXTERNAL does not supply the password that FILEHOST expects, so an
EXTERNAL connection cannot send or receive FILEHOST attachments.

Each `crew[]` member uses exactly one of `passwordEnv` or `clientPemFile`,
just like the captain. PLAIN and EXTERNAL accounts can share a ship. Each
EXTERNAL member presents only its configured PEM, never the captain's
certificate. All certificates require TLS and the same private-file checks.
For example, replace a crew member's `passwordEnv` with
`"clientPemFile": "/srv/private/galactica-chief.pem"` after the operator has
registered that certificate with the member's account. Keep passwords in
separate environment variables for accounts that still use PLAIN.

Adding EXTERNAL crew through SIGHUP validates their PEMs before committing
the roster. Changing an existing member's authentication reference requires
a restart. Replacing a PEM at the same path also requires a restart: reload
does not rotate the certificate held by an existing connection. Authentication
references do not change the native session or durable queue namespace.

The namespace of each IRC connection includes the server host, port and
`network` name, the registration ID, the account and the backend settings.
Moving a registration to another host, port or network therefore starts new
queues, outboxes and unpinned sessions; a pinned captain keeps its native
session but starts a new delivery cursor at current history. Set `network`
so a server that announces another network is refused before Stargate joins
anything.

### One captain on Slack and IRC

A captain is reachable the same way on both transports when its Slack bot
and its IRC registration pin the same OpenCode `sessionID`. This is the only
cross-registration pin that `config check` accepts: at most one Slack bot
and one IRC registration per session.

The two registrations keep separate queues, cursors and namespaces. Each
delivers only replies that history attributes to its own native inputs, so
a Slack request is never answered on IRC or the other way round. Native
OpenCode queues a turn that arrives while the other transport's turn runs;
its time limit includes that wait. Crew results return to the transport of
the request that dispatched them.

## Access

`access.peerTurnsPerHour` overrides the default of 30 peer turns per receiving
connection and conversation in a rolling hour (0–600, with 0 refusing peer
turns). It reloads live with the other access settings and
`shipTurnsPerAgentPerHour`. Deployments that relied on the old default can
keep it by setting `access.peerTurnsPerHour: 5` explicitly.

- The sender's identity is the IRCv3 `account` tag, never the nick. A
  message without an account tag is ignored.
- Any logged-in account may write to the captain, unless
  `deniedAccounts` lists it. `*` denies everyone. Set
  `access.allowedAccounts` to permit only those exact accounts. Denies
  still take precedence.
- Set `access.channelRequests: "nick-mention"` to require the current nick
  as an exact mention in a channel the connection has joined. A reply,
  text mention or all-call alone cannot start a turn in this mode. Both
  DMs and channel requests must have a server message ID, which is used
  for durable deduplication. Bot-tagged messages, history replays and stop
  reactions are ignored in this mode, except for the explicit human wake
  channel policy below. Enable only the channels this
  registration is authorised to join.
- Channel messages count only in the registration's `channels` and not in
  `deniedChannels`. `deniedChannels: ["*"]` also blocks direct messages.
- Denies are checked again before work and before each delivery, including
  queued socket writes. A SIGHUP deny also blocks delivery from a running turn;
  its execution/transcription settings stay on the starting snapshot. New allows
  affect only future turns. Joined channel lists still require a restart.
- Accounts, nicks and channels compare under the server's ISUPPORT
  `CASEMAPPING` (`rfc1459` until the server sends it; Ergo sends `ascii`).
  Every spelling of a channel shares one conversation, deny entry and turn
  limit. Duplicate checks in the configuration use `rfc1459`, so names
  that any classic mapping treats as equal count as duplicates.
- The registration's own account is never admitted: echoes and other
  sessions of the same account are ignored.
- NOTICE, TAGMSG and CTCP messages never start a turn.

A channel message starts a turn when it:

- names the agent's nick as a whole word, for example
  `galactica-captain: status?`;
- contains one of `access.textMentions` (captain only);
- is an **all-call**: it contains one of `access.allCallWords` (default
  `all hands`, `all crew`, `everyone`; whole words, any letter case, so
  `Everyone,` counts and `everyones` does not). An all-call reaches the
  captain and every crew member in that channel, in turn (see
  [all-call turns](#all-call-turns)). `[]` turns all-calls off; or
- is a `+draft/reply` to one of the connection's own recent messages.

No other channel traffic reaches a captain or crew session.

### Optional human wake channels

`access.humanWakeChannels` is an opt-in policy for the captain connection;
crew connections keep their ordinary mention rules. It requires an explicit
`fleetPolicy`: only its verified human SASL accounts can use automatic wake.
The ordinary account allowlist, channel allowlist and denies still apply.
Every eligible request needs a real server message ID and a joined channel.
Agent accounts, bot-tagged messages and unauthenticated messages cannot use
this policy. The audit channel is never eligible.

```json
{
  "channelRequests": "nick-mention",
  "allCallWords": [],
  "humanWakeChannels": [
    { "channel": "#bridge", "replies": "participating" },
    { "channel": "#home", "replies": "all" }
  ]
}
```

Each listed channel must be in the captain's `channels`, without duplicate
names under IRC case folding. Omission preserves existing routing. This policy
can coexist with strict `channelRequests`: other channels still require the
current nick. Existing `wakeChannels` retains its separate legacy behaviour,
which can wake on any admitted account and is incompatible with strict mode.

Both new modes admit every top-level human message in the listed channel,
including a message addressed to another fleet agent. This is intentional
channel-wide delivery; each agent may answer `[[stargate:silent]]` when it has
nothing useful to add. A top-level broadcast does **not** make every listener
a permanent thread participant.

- `participating`: a reply starts a turn only after the captain has published
  its own response in that thread, or a human has explicitly invited its exact
  current nick. An exact current-nick mention can invite it to a valid unknown
  thread. An accepted but silent broad wake does not join the thread.
- `all`: every human reply with a valid parent also starts a turn, even if the
  captain has not answered or has never seen that parent. An unknown parent is
  retained only as an opaque reply anchor: it does not prove historical text,
  sender or authority. The source remains the current verified human message.
  Malformed, empty or contradictory reply tags are rejected in
  either mode; they never fall back to a top-level broadcast.

The gateway uses actual `+draft/reply`/`+reply` and server `msgid` tags, with
durable ancestry and participation scoped to registration and canonical
channel. A human invitation is recorded atomically with accepted intake.
Publication joins a thread only after the server echoes a matching pending
send with the expected SASL account and an existing request ID. Merely seeing
an own-looking nick, replaying an old output or accepting an unaddressed root
does not count. Without a confirmed own echo, participation stays conservative;
an explicit human invitation still works. No in-flight broad wake is treated
as permanent membership.

Membership survives gateway restart. Eligible human history replays in these
explicit channels use the same rules and durable request deduplication;
strict mode still ignores history elsewhere. Reply ancestry and membership
grant no identity, tool permission or human approval. Peer dispatch/result
correlation, budgets, source evidence and audit exclusion remain unchanged.

A direct message to the captain always starts a turn. Crew connections
ignore direct messages. With `dmPolicy: "redirect"`, no direct message
starts a turn (see [DM audit](#dm-audit)).

Access rules are request filters, not isolation. An admitted account can drive
the captain's enabled tools.

### Optional human message quiet window

Set `access.humanMessageDebounceMs` to wait briefly for consecutive human
messages before starting a captain turn. Omission or `0` preserves immediate
intake; the maximum is `5000` milliseconds. For example, `2500` gives a sender
2.5 seconds of quiet to finish a request split across several IRC messages.
The primary connection of a rear admiral uses the same option; crew do not.

Every message must first pass the existing account, channel, bot, thread and
human-authority checks. Buffering never admits an unaddressed message where
routing requires an exact nick, or a reply to a thread the captain has not
joined. Use IRCv3 `draft/multiline` on clients to send one long message
atomically whenever possible; a quiet window can only combine messages that
actually arrived and were admitted.

Only consecutive live human messages from the same SASL account, connection,
channel, conversation and reply thread can share a queued request. Changes to
the routing policy, another admitted sender or request, or a different all-call
class end the group. Internal transcript delivery rows and fleet-result
continuations do not end it. History replay, peer agents, crew messages, native
clarification controls and Stop reactions keep their existing paths. A Stop
reaction on any member of a queued burst stops that request immediately.
Ordinary channels and DMs keep their existing thread ancestry and participation
behaviour; buffering adds thread bookkeeping only where human wake already did.

The quiet deadline slides with host receive time, with a hard limit of 10
seconds from the first message. Existing all-call staggering can still delay
execution longer. A group holds at most 16 messages, 64 KiB of original records
and prompt text, and 10 distinct attachment URLs; overflow starts another
request without dropping its content. If optional burst metadata cannot be
represented, the complete message follows ordinary intake instead. Each record
keeps its own original
message ID, timestamp, source reference, text and attachment URLs in private
SQLite state. A grouped prompt labels each message separately; one message
cannot lend its approval to another. Sources become correlated to the single
native input only when that input is actually recorded. Queue state and
deduplication survive a gateway restart. A worker claims only the exact text it
selected; if intake extended it in the meantime, the request stays queued for a
fresh read rather than executing an incomplete snapshot.

This does not interrupt an active turn or steer a running backend session.
Follow-ups arriving after the window, or after execution starts, remain ordered
behind the current request. Slack uses that same running-turn serialization;
it has no equivalent quiet-window option. Slack normally delivers the entire
message and its files in one event, which avoids IRC clients splitting text
into separate requests.

### Configured fleet defaults

New fleet setups can use explicit `fleetChannels` metadata with `fleetPolicy`
and `fleetControl.targets`. Without `fleetChannels`, existing membership and
wake configuration are left unchanged. In this explicit profile, the gateway
joins only target channels whose accounts are enrolled in `fleetPolicy.agentAccounts`
and whose target `role` is `captain`, in addition to its explicit channels.
The ship's own captain and crew accounts are excluded from derived membership
and peer trust. Rear-admiral/crew targets and targets without a role add no membership. This
uses the operator's roster, never IRC discovery or a naming pattern. An
unrelated account or server channel gains no membership.
Invalid derived IRC channel names, audit-channel overlap and the 20-channel
limit fail validation. Stargate
joins existing channels; agents must not create or administer channels.

Set the role's `fleetChannels` once to get standard wake behaviour without a
separate manual wake list:

```json
"fleetChannels": { "home": "#discovery", "command": "#fleet-command" }
```

For a captain, trusted-human messages and valid replies in `home` wake it;
command roots wake it, while command replies need confirmed participation or
an explicit current-nick invitation. A rear admiral's `home` is its private
coordination room: human messages and replies wake it there, and other joined
rooms require a mention. In a configured peer captain's channel or the fleet
command channel outside the visitor's human wake list, type the current `@nick`
of the visiting captain or rear admiral in each message, including replies. The
gateway applies the same policy to queued visitor turns.
Explicit `humanWakeChannels`, legacy `wakeChannels`, account allowlists, denies
and peer caps remain authoritative. An explicit legacy wake list (including
`[]`) prevents automatic human-wake and strict-mention defaults. Use
`channelRequests: "standard"` to explicitly retain ordinary IRC mention,
all-call, reply and replay admission; `"nick-mention"` selects strict admission.
When `peerCaptains` is omitted, only enrolled captain/rear-admiral targets become
peers. An explicit `peerCaptains: []` disables automatic peer trust;
`peerTurnsPerHour: 0` disables peer intake. The normal 50-peer bound still
applies; an explicit narrower peer list can limit a larger roster.
The fleet policy itself restricts enrolled accounts without synthesising an
extra account allowlist or imposing a new 50-human/agent combined limit.
Non-fleet registrations retain
their existing defaults. This configuration does not widen native permissions
or create identities, human authority or an approval route.

Fleet defaults are a runtime view. Parsing or saving a configuration, including
`stargate bot add`, does not persist computed channels, peer lists, access or
wake rules as operator choices. A later roster or human-policy change therefore
recalculates omitted defaults instead of retaining stale derived grants.

Set a captain's rear-admiral target channel to that captain's own room, where
the rear admiral already listens. Captains can then tag the rear admiral there,
without joining its private home or broadcasting a human request in command.
Set every known target's explicit `role` (`captain` or `rear_admiral`) in the new
fleet setup; role metadata guides membership and grants no human authority.
`stargate_mail` and ordinary `stargate_dm` calls address the local team.
OpenCode captains with fleet peer messaging enabled can use
`stargate_dm({"op":"send","to":"captain-two","text":"Can you confirm the test result?","via":"ship"})`.
The gateway sends one tagged IRC message to that captain's configured ship
channel. Use `via: "command"` to send it in the configured fleet command channel.
The gateway verifies the recipient's current nick and adds the only mention.
Keep the message body free of `@` characters. A send receipt confirms transport
only. Inspect the channel before sending again after an uncertain outcome.

For formal work or review assignments, read `fleet_status` for target IDs and use
`fleet_dispatch` with the retained original source and a stable request ID.
Inspect an unknown dispatch outcome with the original ID.

### Peer captains

`access.peerCaptains` lists the accounts of other fleet captains. The list
is explicit; a naming rule such as `*-captain` is not used, because the
server operator assigns account names and an explicit list cannot match by
accident. Peer messages follow the Slack peer rules: the source line ends
with `;k=captain`, they carry no operator or Admiralty authority, and Stargate
applies the configured IRC peer turn limit. A peer list cannot contain this
ship's own accounts.

When the optional `fleetPolicy` is configured, strict nick-mention mode admits
bot-tagged context only from a real SASL account present in **both**
`fleetPolicy.agentAccounts` and `access.peerCaptains`. The ordinary account
allowlist, denies, current nick mention, joined channel, live msgid, replay
rejection and peer budget still apply. A direct message still needs the
captain's current nick. Without that explicit fleet policy/peer intersection,
strict bot rejection is unchanged. These senders remain agents, with no human
approval or Stop authority.

When `fleetControl.results: true` enables the
[correlated fleet result outbox](fleet-tools.md), ordinary authenticated,
enrolled peers may still start a context turn with an exact current-nick mention.
Use `@nick` to address a visiting captain or rear admiral in the channels above.
The default is **30 peer turns per receiving connection and channel or DM in
a rolling hour**, shared by ordinary peer messages and correlated handoffs.
Peers get no automatic human wake or human approval.
Their original text and the exact admitted nick are retained. Execution and
delivery recheck current identity/access/peer policy against that captured
recipient, so a fallback nick or nick recovery does not discard accepted work.
An old queued row without that explicit address remains refused and retained.

The reserved `[fleet_dispatch ...]` label must match a retained dispatch
validated by the assignment recorder. Malformed, forged or uncorrelated labels
never fall back to ordinary peer chat, including when addressed to the captain.
Only the protected correlated native outcome returns through the durable outbox
to its original conversation; arbitrary IRC text cannot select that destination,
declare completion or impersonate a human approval. Ordinary peer chat does not
create a correlated assignment or completion receipt. Silent acknowledgements
remain appropriate. Ordinary addressed replies, including acknowledgements,
can start another peer turn. Two agents that keep addressing each other can
use up to the configured limit each per conversation in a rolling hour. The
cap persists across restarts. Some feedback can still occur because peer
admission does not filter acknowledgement prose. Each joined channel is a
separate conversation. Operators can narrow the peer list, lower the cap or
set it to 0 to disable peer intake.

Outside protected human wake channels, an explicit leading address to a known
other fleet agent (`vance:`, `vance,` or `@vance:`) prevents a results-mode human or peer message
from waking this connection. A later mention or reply tag does not override
that recipient. A leading list of explicit `@nick` mentions can intentionally
address several agents in one atomic notice; mentions later in prose do not
change the leading recipient. Protected home/command human wake rules remain authoritative:
their top-level delivery still reaches the configured captains, and their reply
policy still applies. Fleet account names and target IDs use the server's case
mapping. Other human messages retain their usual mention and wake rules.

Results-mode human jobs retain their original leading address in queued text
so the same recipient rule applies after restart. A correctly addressed
`discovery: vance: ...` therefore remains Discovery's request. An old queued
row whose retained text starts with another fleet recipient outside a protected
human wake channel fails the normal access check; historical rows and their original source evidence are not
rewritten or replayed.

## Conversations

| IRC             | Stargate conversation               |
| --------------- | ----------------------------------- |
| Channel message | One conversation per channel        |
| Direct message  | One conversation per sender account |

A pinned captain uses its one session for all of them. Each turn carries a
source line:

```text
s=irc;c=%23ship-galactica;t=<msgid>;m=<msgid>;u=jack[;k=crew|captain][;r=<thread-root-msgid>]
```

Unpinned sessions (crew, Pi Durable) get a one-line note instead, for
example `[IRC #ship-galactica, from account jack. IRC shows plain text only.]`.
New sessions use the title `<name> (irc <channel>)`.

Turns in one conversation run in order. IRC message IDs deduplicate a
message that arrives twice, for example from a history replay.

`t` and `m` identify the incoming request, including when it is a thread
reply. Optional `r` identifies its reply parent, which is the first message
of a one-level thread. Values are percent-encoded. The gateway reads the
IRCv3 `+draft/reply` tag (`+reply` remains accepted for compatibility). If
the parent names one of this connection's recent threaded answers, the
gateway uses that answer's known root instead. It does not fetch arbitrary
thread history or trust the tag as sender identity. The authenticated
`account` tag and existing access checks still govern admission.

## Replies

- Agent Markdown becomes plain text: headings, emphasis, fences and table
  rules are removed; links keep their URL; inline code keeps its backticks.
  Control characters are removed, so a reply cannot send CTCP or IRC
  formatting.
- IRC profile and fleet guidance asks agents to send one pull request reference:
  a standalone `[PR:owner/repo#number]` marker or the full GitHub pull request
  URL in plain text, outside backticks and Markdown link syntax. Clients that
  recognise pull request references can display it as a chip.
- Each line fits 512 bytes, including Stargate's tags and the source prefix
  that the server adds. Long lines break at spaces, otherwise at a UTF-8
  character boundary. Blank lines are not sent.
- With `draft/multiline`, each stored reply chunk goes as one batch (more
  only when it exceeds the server's `max-bytes` or `max-lines`); a long line
  is split losslessly and continued with `draft/multiline-concat`. Every
  fragment fits both one IRC line and `max-bytes`, and a batch counts each
  line's text plus one byte per line break (at least what the server
  counts). A line longer than `max-bytes` continues in the next batch, so
  clients show it as two messages. The server delivers a batch atomically.
  A `max-bytes` below 64 is not used. Without multiline, lines are sent
  one by one.
- A person's top-level channel request to a captain starts a thread at its
  server message ID. In standard channels, a requester enrolled as human in
  the fleet policy can continue their thread after the captain's answer
  without naming the captain again. An explicit address to another officer
  takes precedence. Replies
  already in a thread stay in that one-level thread. Top-level agent-to-agent
  messages and requests without a server message ID keep plain answers.
  Every threaded plain-text reply line and every multiline BATCH opener
  carries the root tag. Ergo 2.19.1 takes
  client-only tags from the opening BATCH line, so tags on its inner lines
  are not a substitute. The protocol formatter escapes tag values.
- Reply routing metadata is stored with each admitted request. Retries and
  transcript catch-up retain it without rerunning the agent. Reactions and
  Stop still target the request message, not the thread root. Missing
  `message-tags` capability means plain replies, as before; SASL and
  `account-tag` remain required. Stargate already requests `message-tags` and
  `echo-message` when offered; no new configuration switch is needed.
- A threaded direct message also receives replies tagged with its thread
  root. An ordinary direct message keeps the existing behaviour: replies
  tag the request's own message ID.
- A direct reply goes only to a nick that WHOIS (`330`) shows is logged in
  to the requester's account at that moment: the last nick seen for the
  account, then the account name. A nick with another account, or none,
  never receives it; the delivery fails and retries later. Account/nick
  hints are dropped on QUIT, NICK, PART, KICK, logout and reconnect. Each
  direct line or complete multiline batch is checked again before its first
  socket byte, after the send throttle and any socket backpressure: if the
  binding was dropped meanwhile, the unsent unit is discarded and the stored
  reply waits for a retry. A partially submitted unit must finish to preserve
  IRC framing; it cannot be retracted. A nick that changes
  hands with no event Stargate can see (no shared channel) after the WHOIS is
  not detected for that chunk.
- Sends are throttled: a burst of 4 lines, then one line every 600 ms.
- For registrations using typing, Stargate sends `+typing=active` (TAGMSG) every 3 seconds while a turn runs
  and `+typing=done` before the reply. Typing is skipped while replies wait
  in the send queue, so it never delays them. In a direct message it goes
  only to a nick that WHOIS shows holds the requester's account, checked
  again for each TAGMSG and at the socket write, as for reply lines; once
  the nick changes hands, typing stops for that turn.
- With `labeled-response`, each line waits for the server's labeled echo or
  `ACK`; a labeled error fails the delivery. A line that is still in the
  send queue at the confirmation deadline (20 seconds) is removed and never
  written later, so a delivery that already failed cannot send it twice.
- `[[stargate:silent]]` posts nothing. `[[stargate:react:NAME]]` sends a
  `+draft/react` TAGMSG to the request's message.
- A reply is stored before delivery. A failed delivery retries the stored
  chunk later and never reruns the agent. Stargate stores how it split each
  chunk into units (batches or lines) and how many the server confirmed, so
  a retry resends only the units after the last confirmed one; only a unit
  whose confirmation was lost can repeat. When the server no longer offers
  `draft/multiline` before a retry, or its limits no longer fit a stored
  batch, the remaining batches become plain lines, each stored as its own
  unit, so confirmed lines are not repeated either. Delivery waits up to 30 seconds
  for a reconnect, then retries with the gateway's backoff (eight attempts).

### Stop by reaction

A person stops an active (queued or running) turn by reacting to its
request message, or to a bot message that answers it, with one of
`irc[].stopReactions` (default `["✋", "🛑"]`; skin tones and the emoji
variation selector are ignored; `[]` turns Stop off). Stargate then cancels the
turn exactly like Slack Stop: the cancel signal reaches the backend, the
"stop request" notice is posted, and tool effects are not rolled back.
Only people can stop a turn: the reaction needs an account tag, must pass
the deny lists and channel rules, and this ship's own accounts and peer
captains are ignored. Any admitted person in the conversation can stop it,
not only the requester. A reaction to the request stops every ship agent
working on it (for example after an all-call). `+draft/unreact` is ignored:
a Stop cannot be undone.

### Not available on IRC

- **Edits and deletion.** Stargate never edits or deletes an IRC message, so
  there are no streaming previews, waiting messages, activity boxes or
  cancellable maintenance notices. A captain tool that needs a cancellable
  notice stays fail-closed on IRC.
- **Redaction.** `draft/message-redaction` is not used: Ergo ships with
  redaction disabled. The extension point is the optional `remove` method
  of the delivery interface (`SlackDelivery.remove` in `src/gateway/gateway.ts`),
  which `IrcDelivery` does not implement; a `REDACT <target> <msgid>`
  version would go there, used only when the server offers the capability.
- **Buttons and interactive controls.** Stop is a reaction
  ([Stop by reaction](#stop-by-reaction)); there is no Stop button.
- **Undo of Stop.** `+draft/unreact` is ignored.
- **Files without a FILEHOST.** Subspace chat uploads can reach enrolled
  officers over the Subspace API. Publishing a local file from a reply uses
  FILEHOST and needs an available host. See [files](#files).
- **Slash commands.** No `/cron`, `/stargate` commands or scheduled prompts.

## Files

### Subspace chat uploads

The Subspace desktop includes a visible `UPL-…` reference for each file in
the same IRC message as the request. Stargate recognises these references
after admitting the message. It uses the addressed officer's
[Subspace signing proxy](subspace-agents.md) to read the file's metadata
and bytes, verifies their size and digest, and passes the files with the
request on attachment-capable backends. This works with SASL EXTERNAL.
It uses the configured signing socket for the IRC registration, or the
single enrolled officer whose configured `ircNick` matches the IRC account.
The IRC message and its references remain visible.

The upload expires after 30 days. The same limits as FILEHOST apply to
automatic delivery, including 10 MiB per file and 25 MiB in total. A missing,
expired or oversized file produces a notice in the originating conversation.
On installations or backends that receive the reference as text, an officer
with Subspace API access can use `subspace_read_chat_upload` or fetch
`/api/v1/chat/uploads/<reference>/content` through its existing API access.
Captains can include the original reference in a crew assignment. Crew with
their captain's Subspace access can read it using the same routes.

### IRC FILEHOST

Ergo can advertise a FILEHOST: an upload URL in ISUPPORT
(`soju.im/FILEHOST` or `draft/FILEHOST`, see the
[spec](https://github.com/emersion/soju/blob/master/doc/ext/filehost.md)).
Set `server.filehostOverride` to the same upload URL when the server does
not advertise it. When both exist with different origins, Stargate turns files
off and logs one warning. The URL must be HTTPS; plain HTTP is accepted only
on `127.0.0.1`/`::1` and only when the IRC connection is plaintext.

**Files in** (`features.filesIn`): a link in an admitted message whose
origin is exactly the FILEHOST origin becomes an attachment, as for Slack
files (at most 10). Links to any other host stay text and are never
fetched. Stargate downloads with HTTP Basic and the registration's own SASL
account and password, refuses redirects, verifies TLS with `server.caFile`,
and applies a 30-second timeout and the attachment limits (10 MiB a file,
25 MiB in total). HTML, XHTML and SVG (declared or detected) reach the
backend as `text/plain` source, never as a renderable page. Audio and video
use the same path as Slack voice notes: with `irc[].transcription` (same
settings as for Slack bots, without `spokenMentions`), Stargate replaces them
with a transcript; without it, they go to the backend as files. A download
failure ends the turn with the attachment failure notice, as on Slack.

**Files out** (`features.filesOut`): files that the agent publishes with
`![caption](file:///absolute/path)` (the Slack path, see
[attachments](attachments.md)) are uploaded to the FILEHOST with the same
credentials (`POST`, `Content-Type`, `Content-Disposition` with the file
name), after the reply text. Stargate then posts one line per file,
`caption: URL`. The upload's `Location` must be on the FILEHOST origin and
carry no user name or password; any other answer makes the file
unavailable, and Stargate never posts such a URL. The FILEHOST serves uploaded HTML sandboxed and renders
Markdown, so `.html` and `.md` links open as pages. Upload is part of
delivery, and Stargate never repeats an upload that may have stored the file:
it records "uploading" before the `POST` and the returned URL before the
link line. A retry posts a recorded URL without uploading again. When an
upload had no certain outcome (Stargate stopped, the answer was lost, it timed
out, the FILEHOST answered `429`, a `5xx` or another unexpected status, or
a `201` without a usable `Location`), the file becomes unavailable and Stargate
posts the "attachment is unavailable or its upload is unconfirmed" notice;
the FILEHOST may then hold an unlinked copy. Only a proven refusal (`400`,
`401`, `403`, `413` or `415`), after which the FILEHOST holds nothing, is
tried again. A crash between the post and the record
can repeat only the link line. Without a FILEHOST, or with `filesOut` off,
Stargate posts the existing "attachment is unavailable" notice.

## Connection

- CAP 302 negotiation, then SASL PLAIN, then `CAP END`.
- Keepalive: Stargate sends PING after 60 seconds of silence and reconnects
  after 150 seconds without data. Server PINGs are answered at once.
- Reconnects use exponential backoff from 1 second to 2 minutes, with
  jitter. A refused login or a server without required capabilities waits
  5 minutes.
- If the nick is taken, Stargate uses `<nick>_` and retries the configured nick
  every 30 seconds.
- Catch-up with `draft/chathistory`: see [catch-up](#catch-up).
- Shutdown sends `QUIT` and closes every connection before workers drain.
- IRC connection failures never stop Slack or Stargate startup; they retry in
  the background.

## Catch-up

With `draft/chathistory` (and `features.catchUp`), each IRC connection
keeps cursors in SQLite: the newest server time it has seen in each of its
channels and with each direct-message partner (by nick), plus a
direct-message baseline set on the first start. A cursor moves only after
a message has been stored or refused, so a stop between the two replays
it. Each partner has its own cursor, so one partner's newer message never
skips another partner's older ones. On every connect and reconnect Stargate
asks for what it missed:

- for each joined channel, `CHATHISTORY AFTER <channel> timestamp=<cursor>`;
- for direct messages, `CHATHISTORY TARGETS` from the baseline, then
  `AFTER <nick>` from that partner's cursor (or the baseline) for each
  partner with a newer message (crew connections ignore direct messages
  anyway). A partner known under a new nick starts from the baseline;
  message IDs prevent a second admission.

Requests ask for at most 100 messages (or the server's `CHATHISTORY`
limit) per target. Replayed messages go through the same access, trigger
and turn-limit rules, and their IRC message IDs deduplicate them against
messages already stored, so nothing is admitted twice. The replay window is
at most `irc[].catchUpHours` (default 24, maximum 168): an older cursor
starts there, and replayed messages older than that are ignored. On a first
start without a cursor, Stargate sets the cursor to now and replays nothing, so
an existing backlog is not answered. Replayed reactions never stop a turn.

## Background questions and request status

On a pinned OpenCode captain with native questions enabled, set
`questionOperator` to one authenticated IRC account already admitted as a
human. When an earlier standalone synthetic input has a supported question,
the captain sends that account a private reference. Use `show Q…` in the DM
to see the form and `answer Q… 1` to select the first option. The answer
window lasts 30 minutes after showing the form. Both commands work when
ordinary DMs redirect to the ship channel. The gateway keeps these exchanges
out of the DM audit mirror. Once a native reply is attempted, its IRC token is spent, including when OpenCode rejects the reply or the acknowledgement is lost. A confirmed native outcome is retained. Use OpenCode to inspect a question that still shows an uncertain outcome.

Live progress is on by default for enrolled humans' captain and rear admiral
requests when turn status is enabled and the backend emits progress events.
After three seconds, a longer turn shows the latest observed stage. Fast
turns can show a terminal notice before any other progress update. Routine updates are coalesced. In a registration with
enrolled humans, `captain: status` is reserved for checking a request. Reply to
your original request using the ship's account or nick. The gateway checks that
you own the request before returning its latest observation. Set
`features.liveProgress: false` to disable these notices and release the status
command for ordinary messages. The Fleet API captain summary includes up to 16
recent observations. Private content stays in the backend.

### Request progress tags

On a server that negotiates `message-tags`, Stargate sends eligible progress
updates as `NOTICE` with both `+stargate/progress=<stage>` and
`+draft/reply=<request-msgid>`. The reply tag identifies the original message
that triggered this request. Two requests under the same thread root have
different progress reply tags. Clients should use the server's authenticated
`account` tag to verify the expected ship account before acting on these
client-supplied tags. The notice text is for people and can change.

The fixed stages are `received`, `submitting`, `accepted`, `queued`,
`delivered`, `model`, `reasoning`, `tool`, `retry`, `waiting`, `clarified`,
`reply`, `completed` and `failed`. A nonterminal backend observation may have
the suffix `,disconnected` while its event stream is offline. The gateway
may skip intermediate observations. A follow-up notice that only reports
the lack of a confirmed backend observation carries no progress stage.

- `completed` means the gateway settled the stored successful response using
  its usual delivery receipts. This can follow resumed delivery after a
  restart. An unconfirmed send with a receipt outstanding remains pending.
- `failed` means the gateway stored a known request failure, such as a
  provider rejection, a timeout or an accepted Stop. The error reply has its
  own delivery path and may still be pending. A delivery retry may repeat
  the same failure marker.
- Interrupted execution, unread reply history and unclassified or ambiguous
  backend errors have no terminal marker. Use the existing status and
  recovery paths when the outcome is uncertain. Delivery of the marker itself
  is best effort. After a disconnect, a terminal notice can wait briefly for
  the IRC connection alongside normal reply delivery.

Stargate uses the existing fleet turn-status policy and requires an actual
request message ID for a marker. Final replies and native questions keep their
existing thread routing, and `+typing` remains scoped to the channel or DM.
See the [loopback IRC transcript](../tests/fixtures/irc-progress.irc) for two
requests in the same thread, an ordinary notice and the final replies.

### Agent dispatch tags

With [agent dispatch](agent-dispatch.md) enabled, the rear admiral's gateway
writes `+stargate/dispatch=<kind>,<value>` requests to captains in the fleet
command channel, and captains answer with a `NOTICE` that replies to the
offer. Only a request from the captain's rear admiral, an enrolled fleet
agent that is a `fleetControl.targets` entry with `role: "rear_admiral"`, is
never dropped by `access.peerTurnsPerHour` (it still counts towards it). A
request `PRIVMSG` carries only fixed text built from the marker; the
user-editable issue title follows as a separate `NOTICE`, which never starts
a turn. The captain also rebuilds the agent turn from the marker, and an
offer is recorded only in `fleetChannels.command` when that is set. The
same marker from any other account is an ordinary peer message. See that
page for the markers, the answer tool and the limits.

## Native clarification questions

OpenCode clarification forms can be answered from the original IRC conversation.
For OpenCode registrations with an explicit, nonempty `fleetPolicy.humanAccounts`
list, native questions are on by default. Set `features.questions: false` to
opt out. Changes to live IRC access rules apply to pending questions as well
as new requests.
A broad IRC access allow-list and absence of a bot tag do
not prove that an account is human. Stable current access/human policy is separate from live IRC registration and
channel readiness. Readiness gates publication; a disconnect or a not-yet-joined
startup cannot discard native ownership or permanently deny an outcome notice.
The same human policy is checked again when
a source is admitted and when a reply is received, including after reload.

Stargate reads the native form APIs; it does not ask a model to invent a question
or select an answer. It verifies the form's `question` kind, exact native session,
running question-tool message and call ID, and delivered input ancestry. The
input must belong to an admitted message from an authenticated human. Scheduled
work, peer/crew requests, fleet results, another transport's input and an unknown
source cannot borrow the last human's authority. Only IRC messages admitted with
this option enabled, an authenticated account and a server message ID receive
the required source proof; older inputs are not retroactively admitted.

The bot posts the question and numbered options as a reply to the original
request. In that same thread, the original requester can send:

```text
galactica: answer <token from the question> 1
galactica: cancel-question <token from the question>
galactica: renew-question <expired token from the question>
```

An explicit `@nick:` address works with the same token controls.

One string field accepts a displayed choice number, or free text when the native
field allows it. A multiple-choice field accepts comma-separated numbers.
Several fields require a JSON object using the displayed field keys and native
option values, for example `galactica: answer <token> {"q0":"wait"}`. The token
lasts 30 minutes from its first publication attempt. A disconnected ship waits
until it can attempt publication before starting that window; a lost
acknowledgement does not extend a token that may already have been seen.
No default or previous answer is shown or submitted. Hidden,
conditional, authentication, credential-bearing and unsupported fields are not
bridged; use the native operator interface for those forms. Never send credentials
in an IRC answer.

Controls display the stable authenticated bot account, so a temporary fallback
nick cannot make a printed command stale. Intake also accepts the current nick.
The target bot (its account or current nick under the server's casemapping), current allow-list, authenticated original account, channel,
thread, token, form fingerprint and native input must all still match. A nick
alone proves no identity. Tokens accept either hex case. All ships reserve targeted `answer` and
`cancel-question` and `renew-question` controls, including unmistakably malformed
near-token-length hex/punctuation variants (at least 24 hex characters), before ordinary intake, so another captain does not
treat the control as a new prompt. These decisions answer a clarification only;
they never grant tool permission or generic human approval.
Ordinary requests such as `galactica: answer Bob's question` remain model prompts,
including when the question bridge is disabled. The question's server message ID
is stored against its original thread, so replying to the question still works
after a restart without relying on the connection's in-memory echo cache.

Question offers and spent tokens survive a restart. A native reply attempt is
recorded before its API call. If the outcome is uncertain, that token stays spent
and no answer is automatically retried; an operator must inspect OpenCode.
Legacy attempted rows with no persisted outcome remain uncertain: an old inline
notification is not durable proof that the native reply succeeded.
Polling never renews expired offers or reposts a waiting question unattended.
The original human may send `renew-question` with the expired token in the same
thread. An expired, never-attempted offer can then receive a fresh token only after the still-pending
native form, original input and current human access are revalidated. The renewed
offer is posted explicitly; the old token no longer works. Expiry never answers or
cancels native work. Spent or uncertain attempts are never renewed. Publishing can repeat the same
offer after a lost acknowledgement; this is not an exactly-once delivery claim.
Renewal and ordinary polling share one in-flight offer publication.
Native reply outcomes and notification delivery are stored separately. A failed
confirmation retries the notice, not the native reply. Concurrent answer/poll
paths share one in-flight notice; a restart after a lost acknowledgement can
still repeat a notice. Failed notices back off exponentially up to one minute,
rather than repeating on every poll. An API deadline still
produces an uncertainty notice while the gateway and original source remain authorised.

One unavailable native session does not prevent the others from being polled.
Transient failures use exponential retry delays up to one minute. A verified
missing session suppresses polling for at most one minute; the cache is also
cleared when the session leaves the active list, including an empty list. A matching native
session-not-found result closes its offers and releases an otherwise orphaned
recovery hold as interrupted work, never as a successful completion. Cancelled
requesters receive no outcome notice. Notices denied by a later access/human
policy change are suppressed without publication, while their native outcomes
and any recovery holds remain durable. Their spent records remain durable without
repeated native polling once no recovery hold remains. A cancelled recovered
waiter still preserves its unknown native work until real settlement or verified
session loss, including after another restart. Only an already-established hold
with exact historical source/native evidence receives that exception; it restores
no reply or notice authority. A new cancellation without that established hold
keeps ordinary Stop and recovery behaviour. Cancelling a chat request never
fabricates a native form answer.
A filtered or temporarily unreadable question is not proof that its native form
has ended. Unsupported owned question forms produce a fixed operator-required
notice without revealing their fields, values, defaults or answers. Native form
state is checked independently before an offer closes. Immutable ancestry is
cached in a bounded process-local map; live form, tool and original input state
are still checked before an answer.

Settled question/source proofs and IRC thread membership metadata are retained
for 30 days. An IRC background task runs indexed cleanup once per minute,
removing at most 256 rows per table/registration in each batch; intake never
runs this cleanup. Active work and recovery
holds are retained; outcome notices for settled work share the 30-day window. Historical source
proofs are removed with spent offer metadata, so pruning cannot make an old
question eligible for a fresh answer. Existing thread membership and ancestry
retention timestamps refresh on continuing admitted/verified publication
activity; a thread does not expire merely because its first participation is old.
Existing parent mappings remain available while recent participation keeps their
exact bot/channel/root active, including across restart. Inactive threads still
use the 30-day retention window. An inactive thread older than this history window
may require a fresh explicit mention to establish participation again.

Ordinary interrupted-work recovery remains unchanged. Its only exception is an
already-persisted offer whose exact native form is still pending and whose
original human/input binding can be revalidated. Stargate keeps that native
waiter and holds new inputs until the native execution settles. An admitted native reply attempt or persisted native outcome also proves its
original input for restart recovery, even when its form is already resolved
before the first restart. This does not resubmit a reply or prompt. Once established,
the exact historical source/input hold survives later restarts even when its
form has resolved or disappeared while the input is still busy. A failed
settlement read also leaves the hold intact; only verified input settlement or
explicit session loss releases it. This restores no answer or notice authority. If any question-recovery lookup
fails or times out during startup, the gateway fails startup before ordinary
interruption or job reset. A failed read for another offer cannot discard a
known hold; native work and durable job state stay untouched. The existing
transcript outbox then delivers the continuation to the original source, without
re-prompting the agent or selecting an intervening human request. A form that
was never durably observed does not receive this exception.

An authenticated human Stop on the original request, or its durably correlated
bot clarification message, invokes the adapter's
exact-input interruption even for a recovered waiter with no local worker.
With questions enabled, strict IRC mode accepts these fresh reactions only from
explicit human accounts, without a bot tag; replayed reactions remain ignored.
The gateway durably claims the Stop attempt before calling the input-scoped API.
The adapter revalidates native session/input ownership; there is no fallback to
interrupting an uncertain whole session. A failed/uncertain Stop is not blindly
replayed after restart. An old cancellation flag, expiry, reconnect or outcome
notification is never a new approval to issue native Stop. Native settlement
still determines when the held queue is released.

Pinned OpenCode IRC captains offer gateway handoff by default. The paired
crew plugin uses it when the captain's gateway is polling. See
[the crew question setup](agents/default-opencode.md#crew-questions-with-a-read-only-history-service).

## Presence

### Fleet typing indicators

By default, Stargate sends IRCv3 `+typing` alongside a human
request's normal captain or rear-admiral thread notices. This requires
`features.typing`, negotiated `message-tags` and a client that renders the tag.
The gateway refreshes the indicator during the turn and sends `done` at the
end. Set `features.fleetTyping: false` to disable fleet typing.

### Agent waiting status (NET-1637, Step 1)

Captain and crew connections publish their existing Slack waiting phrases as
the nickname's IRCv3 metadata key `status`, when both `batch` and
`draft/metadata-2` are negotiated. For example: `Galactica is thinking…`, then
`Galactica is mulling it over…`. A server without these capabilities keeps
the existing behaviour. There is no new server setting or gateway option.

This is **Step 1**, not an action feed. The value contains only the configured
agent display name (or existing agent/registration-name fallback) and a fixed
waiting phrase. It never includes requests, conversation names, commands,
filenames, arguments, tool output, reasoning or credentials. Control characters
are removed from the display name, and UTF-8 length respects the server's
advertised value limit and Ergo's key-plus-value limit. Nickname metadata is
public across shared channels, including when work started in a private message.

One writer per connection counts active turns across its conversations. An
older turn finishing cannot clear a newer turn's status; only the last turn
ending requests a clear, on success, failure or cancellation. The common
transport lifecycle supports OpenCode, Pi, Claude and Codex without changing
their backend adapters. Conversation-scoped `+typing` and Stop reactions stay
as documented above; a metadata status has no Stop button.

Non-clear updates are at least 15 seconds apart, including across rapid turns.
The writer coalesces pending values and cancels a start whose turn already
ended. It also counts metadata attempts, including startup cleanup and clears,
against a conservative 10-attempt/120-second budget. A busy update reserves a
slot for its terminal clear. Under load, a short turn may show no status rather
than spend the clear reserve or publish an obsolete busy value. Terminal clears
bypass the phrase interval, not the server quota. Rejected or quota-delayed
clears remain pending, respect the server's retry delay, and block newer busy
values until acknowledged.

After each successful registration or reconnect, the writer first deletes its
own `status` key and waits for the server acknowledgement before publishing
busy values. Graceful shutdown attempts acknowledged deletion before QUIT,
within a 140-second shutdown wait. An unavailable or refusing server cannot be
forced to acknowledge a clear.

**Abrupt-disconnect limit:** Ergo 2.19.1 retains metadata for always-on clients
and clients with another session attached. A crash or network loss can leave a
stale value until the gateway reconnects and its clear succeeds. With neither
persistence nor another session, the nickname disappears with QUIT; clients
must discard its cached status then. This feature does not add a metadata TTL,
change persistence, or change server configuration. Another writer on the same
account can also use its shared server quota or overwrite the key.

#### Protocol and proof

The [IRCv3 metadata draft](https://ircv3.net/specs/extensions/metadata) uses:

```irc
CAP REQ :batch draft/metadata-2
METADATA * SET status :Galactica is thinking…
METADATA * SET status
```

The last command deletes only `status`; an empty value is not used as idle text.
Ergo 2.19.1 sends **761** for values and **766** for deletion, including
subscriber notifications, rather than the draft's `METADATA` notification
form. A client subscribes with `METADATA * SUB status`. On Ergo a late SUB
returns 770/774; `METADATA *ALL SYNC` retrieves the current subscribed values.
A subscribed client joining a shared channel receives current member values.
The gateway does not need to subscribe to publish its own status.

Do not replace the single-key delete with `METADATA * CLEAR`: Ergo clears all
keys there and does not notify subscribers. Missing-key deletes and unchanged
SETs also consume its ten-attempt/two-minute quota. Reconnecting to an
always-on account does not reset that quota. `FAIL METADATA RATE_LIMITED`
carries a positional retry delay, which the writer honours.

The implementation is checked with fake wire fixtures and a throwaway local
Ergo 2.19.1 server. These checks are not the live Enterprise pilot proof;
Voyager owns that proof and the gateway owner installs the release. Step 2
will separately add an allowlisted action-category feed to the backend
contract and supported adapters. No real-action text is inferred in Step 1.

Run the optional wall-clock rate proof with
`STARGATE_ERGO_RATE_TEST=1 bun test tests/irc-ergo.test.ts`. It holds a real
gateway status for 125 seconds under Ergo's unchanged 10/120-second quota,
then checks the terminal deletion. It uses only temporary accounts, state and
loopback listeners. Ordinary checks run the shorter real-server lifecycle and
late-join proof when the local Ergo binary is installed.

Each IRC connection (captain and crew) uses these when the server offers
them:

- **Always-on** (`draft/persistence`, switch `alwaysOn`): after each connect
  Stargate sends `PERSISTENCE SET ON`. On Ergo an always-on account stays in its
  channels and keeps receiving direct messages (stored for later) while
  Stargate is stopped or disconnected; with [catch-up](#catch-up) Stargate then
  reads what it missed. Ergo allows this only when
  `accounts.multiclient.always-on` is `opt-in` (or `opt-out`); otherwise
  the server refuses it and Stargate logs the `PERSISTENCE STATUS` it gets.
  Always-on stays set on the server after Stargate stops; turn it off with
  `PERSISTENCE SET DEFAULT` from another client of the account.
- **Bot mode** (ISUPPORT `BOT`, switch `botMode`): Stargate sets that user mode
  (Ergo: `+B`) on its nick after each connect. Clients can show the account
  as a bot.
- **Read marker** (`draft/read-marker`, switch `readMarker`): after a
  message is accepted (stored as a turn), Stargate sends `MARKREAD` with the
  message's server time for that channel, or for the sender's nick in a
  direct message. Messages that are not admitted are not marked read.

## DM audit

The DM audit gives the operator a live copy of every direct message (DM)
that the ship's agents receive or send. Set it per registration:

```json
"audit": { "channel": "#agent-dms" }
```

Without `audit`, nothing is mirrored. The captain connection joins the
channel and posts one entry per DM:

```text
[dm] jack → galactica-captain: status of the fuel tanks?
[dm] galactica-captain → jack: All tanks at 40%.
[dm] jackie (jack) → galactica-captain: same person, other nick
[dm] ghost (no account) → galactica-chief: hello?
[dm] * jack waves (→ galactica-captain)
[dm 2026-11-14T10:42Z] jack → galactica-captain: sent while Stargate was down
```

**What is mirrored**

- Incoming: every PRIVMSG and NOTICE from a user to the nick of the captain
  or of a crew connection, whether or not it starts a turn.
- Outgoing: every PRIVMSG and NOTICE that a ship connection sends to a nick
  and the server confirms: agent replies, Stargate's own notices (for example
  "attachment unavailable" or the stop notice), FILEHOST link lines and
  `dmPolicy` redirects.
- The sender or recipient shows as its nick. When its account differs, the
  account follows in parentheses; `(no account)` marks a user who is not
  logged in. The agent shows as its account.
- A message that [catch-up](#catch-up) replays (it arrived while Stargate was
  stopped or disconnected) shows its server time: `[dm <time>]`. Message
  IDs prevent a second entry for the same message.

**What is not mirrored**

- Typing (`+typing`) and reactions (`+draft/react`): both are TAGMSGs.
  Reactions are left out on purpose, to keep the mirror to text; a Stop
  reaction in a DM is visible in the stop notice that follows it.
- Service traffic: anything to or from a nick that ends in `Serv` (any
  letter case: NickServ, ChanServ, HostServ, …), nicks that start with `*`
  (bouncer modules such as `*status`), and server notices.
- CTCP other than ACTION (VERSION, PING, TIME, …). ACTION shows as
  `[dm] * <sender> <text> (→ <recipient>)`.
- Credentials. When any line of a DM (or of a multiline batch) looks like
  a credential or services traffic, the whole entry is withheld and reads
  `[not mirrored: may contain credentials]`: services commands with an
  argument (`identify …`, `register …`, `login …`, `ghost …`, `passwd …`,
  `set password …`, also after `/msg <nick>`), messages to a `*Serv`
  (`/msg NickServ …`, `nickserv …`), services aliases (`/ns …`, `/cs …`),
  private keys, provider tokens (`xox…`, `sk-…`, `ghp_…`, …),
  `Bearer`/`Basic` values and `password=`/`token:`-style pairs. The check
  reads the raw text: every part after a CTCP delimiter (`\x01`), with and
  without its verb, counts as a line, so `\x01ACTION identify secret\x01`
  or any other CTCP wrapper cannot hide a command. The rule is a
  heuristic: it errs on the side of withholding, and it cannot recognise a
  bare password.
- DMs that another client of the same account sends (for example the
  operator logged in as the captain account): Stargate does not see them as
  sent. Ergo's stored DM history (see below) has them.

**Rules**

- The audit channel is never a conversation: no message in it starts a
  turn (mentions, all-calls and replies included), no reaction in it stops
  one, and catch-up never replays it. Stargate never mirrors what it posts
  there, so the mirror cannot loop. `config check` refuses an audit channel
  that is a captain or crew channel of this registration, or a ship channel
  of any other IRC registration, on any server: host names and ports do not
  prove two servers distinct. The comparison uses one key that is at least
  as coarse as every CASEMAPPING Stargate knows (`widestFold` in
  `src/transports/irc/protocol.ts`, built on the runtime `unicode` fold): Unicode
  compatibility forms, lower, upper and lower case again, then rfc1459.
  So `#Ärger` equals `#ärger`, and `#STRAẞE`, `#straße` and `#STRASSE`
  are one name.
- Each entry stays whole. A long entry splits into lines like a reply. A
  multiline DM is one entry: with `draft/multiline` it is posted as one
  batch, otherwise as consecutive lines.
- The mirror never delays or blocks the message it copies. Entries wait in
  a queue of 256 and go out one at a time on the captain connection's
  low-priority lane, after replies and other traffic. When the captain is
  offline or not in the channel, entries wait. A full queue drops new
  entries, and an entry that waits longer than the confirmation timeout
  (20 seconds) behind other traffic is removed from the send queue unsent;
  both count as dropped. Stargate logs one warning with the count at most every
  10 seconds, and a final count at shutdown. A post that the server refuses or does
  not confirm is dropped and logged. Logs carry counts only, never text.
- The mirror is a convenience view, not the record. Exactly-once is not
  guaranteed: a dropped entry is lost, and a crash can repeat one. A DM
  between two connections of the same ship shows twice (once per side).

**Crew connections and the audit channel**

Crew connections never join the audit channel. Each crew connection hands
its DM entries to the ship, and the captain connection alone joins the
channel and posts them. This keeps the crew rule unchanged: a crew
connection joins only its `crew[].channels`, which must be captain
channels.

The other design would give every crew connection a separately validated
exception to join the audit channel and post its own entries. It was not
chosen:

|                         | Captain posts (chosen)                                   | Each connection posts                   |
| ----------------------- | -------------------------------------------------------- | --------------------------------------- |
| Crew channel rule       | Unchanged                                                | New exception for every crew connection |
| Joins and invite grants | One account                                              | Every ship account                      |
| Entry attribution       | Stargate's text (`[dm] galactica-chief → …`)             | The server's source nick as well        |
| Captain offline         | Crew entries wait in the queue (or drop when it is full) | Each connection posts on its own        |
| Send rate               | Shares the captain's throttle (low priority)             | Each connection's throttle              |

Attribution in the chosen design comes from Stargate's text, not from the
poster's account. That is acceptable because only Stargate posts the entries,
and Ergo's stored DM history keeps the authoritative copy.

**Redirect policy**

`"dmPolicy": "redirect"` (default `"agent"`) stops agents from acting on
DMs. No DM starts a turn. Every connection, captain and crew, answers a DM
from a logged-in account with a NOTICE, `Please ask in #ship-galactica`
(its first channel); a DM without an account gets no answer, so rotating
nicks cannot make Stargate flood. The mirror still records every DM and
answer. Stargate answers each account at most once every 5 minutes per
connection, never answers a NOTICE (so two bots cannot answer each
other), and never answers services or CTCP other than ACTION. Channel
messages are not affected.

**Server setup (Ergo)**

- Register the channel with the operator as founder and make it private:
  `/CS REGISTER #agent-dms`, then `/MODE #agent-dms +Cinst`.
- Give the captain an invite exception: `/MODE #agent-dms +I
  galactica-captain!*@*` (a `galactica-*!*@*` mask also covers crew, which
  this design does not need). Everyone in the channel reads every DM of
  the ship: grant only the operator.
- For a complete record, store DMs on the server (Ergo persistent
  history with `direct-messages: mandatory` and a retention period). The
  mirror shows DMs while Stargate runs; the server keeps all of them.
- `audit` and `dmPolicy` changes need a restart; SIGHUP reload refuses them.

## Crew on IRC

Each crew member can have its own IRC account, for example
`galactica-chief`, with its own `passwordEnv` or `clientPemFile`. The operator
creates these accounts.

### Channels

- A crew connection joins only the channels in its `crew[].channels`. That
  list must be a subset of the captain's `channels` and currently has
  exactly one entry: the ship channel. `config check` compares these names
  exactly, up to ASCII letter case only, so `#ship{1}` is not `#ship[1]`.
  At runtime the crew connection also requires each channel to be a
  captain channel under the server's `CASEMAPPING`; otherwise it never
  joins, answers or delivers there.
- Stargate ignores an INVITE to any other channel and leaves a channel that
  the server joined it to without being listed.
- When the ship channel is invite-only (`+i`) and the crew join fails, the
  captain connection sends `INVITE <crew nick> <channel>`. The captain must
  be in the channel with operator rights (Ergo gives the founder `+q`).
- For a lasting grant that does not need the captain online, the channel
  founder can set an invite exception, for example
  `/MODE #ship-galactica +I galactica-chief!*@*`. With Ergo's
  `force-nick-equals-account`, the nick is the account.
- To remove a crew member from a channel, remove it from the config (or
  ban the account); a kicked crew connection rejoins on its next retry.

### Crew sessions

A crew IRC connection is an ordinary unpinned registration: one session
per channel, using its own `backend` (normally the member's native agent
definition and worktree). It does **not** prompt the crew member's task
session that the crew plugin manages. Stargate refuses a crew backend with a
pinned `sessionID`. A crew member can also run on Claude Code with a
`claude` backend, or on the Codex CLI with a `codex` backend; see the
Galactica examples for [Claude](claude.md#set-up-through-cliproxyapi) and
[Codex](codex.md#set-up-through-cliproxyapi).

Reason: the crew plugin reads a task result from the final answer that
follows the task's input. An outside input after it makes the result
unreadable ("A later input follows this task"). The crew plugin's DM path
also cannot carry a reply back to IRC. Separate IRC sessions keep the task
model intact and need no crew plugin change. To hand IRC work to a crew
member's task session, the captain uses `stargate_crew` as usual.

### Crew-to-crew messages

A crew member hears a ship channel message that mentions its nick, replies
to one of its messages, or is an all-call. It does not see other channel
traffic. The sender can be a person, the captain or another crew member. A message from any of this ship's accounts (captain or
crew) is a **ship message**:

- the pinned captain sees `;k=crew`; crew sessions see a note that the
  sender is a ship account and that acknowledgements need
  `[[stargate:silent]]`;
- An all-call from a ship account counts once for each agent it reaches,
  like other ship messages; an all-call from a person is not limited by
  this cap.
- Stargate admits at most `access.shipTurnsPerAgentPerHour` (default 60,
  maximum 600) ship messages **per agent** in a rolling hour. A channel's
  cap is that value times the ship agents configured in it: the captain
  plus each crew member whose `channels` list it, with names folded like
  every other channel key. For example, a captain and two crew in
  `#ship-galactica` give 180 ship messages an hour; a channel with only the
  captain gives 60. The count is per channel across the whole ship, not
  per sender. A direct message from a crew account to the captain has two
  participants: its cap is the per-agent value times 2 (default 120), counted
  in that direct-message conversation. Later ship messages are ignored with one warning in the log.
  `0` turns ship messages off. Restarts do not reset the count.
- `shipTurnsPerAgentPerHour` replaces `crewTurnsPerHour` (v0.4.0, a flat
  per-channel total). The old key is rejected, so a config that set it
  fails `config check` instead of silently changing meaning.
- No connection ever answers its own messages.

### Breakout channels (future)

Captain-created task channels are not implemented. The extension point is
`IrcShip` (`src/transports/irc/ship.ts`): a runtime grant set beside
`crew[].channels`, filled only by a captain action, which then uses the
same join, invite and invite-ignore rules. Grants must stay captain-owned
and auditable, and the `length(1)` rule on `crew[].channels` would become
a captain-managed limit.

## Response policy

Generated definitions carry the same reply rules for the captain ("IRC
messages" paragraph) and for crew ("IRC sessions" paragraph). Unpinned IRC
sessions (crew, Pi) also get a one-line reminder in each turn's note. An
agent replies on IRC only when:

1. it is tagged and has something useful to add;
2. it must correct a factual error or a wrong instruction in a message it
   can see; or
3. an all-call asks everyone to answer.

Otherwise it answers `[[stargate:silent]]` and Stargate posts nothing. For an
all-call it answers once and briefly, and stays silent if another agent
already said the same. No acknowledgements, thanks, agreement-only or status
messages; one short, specific message, no repeats.

### All-call turns

Agents answer an all-call in turn, so a later agent can see the earlier
answers and stay silent instead of repeating them:

- Turn order in the channel: the captain first, then each crew member that
  lists the channel, in `crew[]` order.
- Agent number _n_ in that order starts its turn _n_ ×
  `access.allCallStaggerMs` after the all-call's server time (default
  4000 ms, 0–30000; `0` turns the stagger off). The captain starts at once.
  With a captain and two crew, the turns start at 0, 4 and 8 seconds. A
  turn can start later when its conversation is busy, never earlier.
- When its turn starts, a crew member's note lists the channel messages
  its connection saw since the all-call, oldest first (at most 20, each at
  most 300 characters), and tells it to answer `[[stargate:silent]]` if one
  already says what it would say. The pinned captain answers first and has
  nothing to read.
- The list comes from what the connection received while it was online;
  it is reference text, not instructions. The stagger does not change the
  ship message caps, ack-silence or "crew speak to the captain" rules.
- A message is an all-call whenever it contains an all-call word, even
  when a nick mention or a `+draft/reply` also admits it, so
  `galactica-chief: all hands, status?` is staggered for every agent.
- `allCallStaggerMs` reloads live with the other `access` settings; a
  reload applies to all-calls received after it.

### Who speaks to whom

Crew speak to the captain, not to each other. The captain coordinates and
gives crew work or information with `stargate_dm` (a reply is needed now),
`stargate_mail` (no reply is needed now) or `stargate_crew`. A crew member reaches
the captain in the ship channel, or with `stargate_dm` to `captain` from its
task session, and reaches another crew member with `stargate_dm` or `stargate_mail`
from its task session. An agent tags another crew member on IRC only when a
person or the captain asks for it in that channel, or to correct an error.
The mention/reply mechanism and the ship message limit stay in force; this
is guidance, not a hard block.

#### stargate_dm and stargate_mail in crew IRC sessions

With `"crewMessaging": { "sessions": true }` (default off), Stargate binds each
crew IRC session to its crew member in the crew plugin, so `stargate_dm` and
`stargate_mail` work there as that member:

- **Binding.** Before each turn of a crew IRC session, once per process,
  Stargate calls the crew plugin's `stargate.crew.irc` `bind` RPC at the captain
  location (the plugin answers it nowhere else) with the session ID and
  the crew ID (`crew[].id`, which must equal the member's ID in the team).
  The plugin binds the session only if it is a root OpenCode session with
  that member's agent in that member's configured worktree, is not the
  member's task session, and the team pins its captain. A binding never
  moves to another member. A failed binding is logged and retried on the
  next turn; the turn does not wait for it.
- **Identity.** The member comes from the binding; the host's tool context
  (agent) must name the same member, so a session cannot send as another
  member and the model cannot choose an identity. Other crew tools
  (`stargate_crew`, `stargate_journal`, …) still refuse IRC sessions.
- **No task.** An IRC session never has a task, not even its member's
  current one: `taskID` is refused, and its mail carries the pinned
  captain as its captain context. Self-sends to its own member are refused,
  so it never prompts that member's task session.
- **Sending.** `to: captain` stores the mail and wakes the captain as any
  `stargate_dm` does. `to: <crew>` goes to that member's task session under the
  existing wake rules: a busy task keeps its result rule ("your final
  answer remains task X's result"), and a task for another captain defers.
- **Replies and inbox.** A reply (`replyTo`) to a message an IRC session
  sent goes back to that IRC session's own inbox, never to the member's
  task session, and never wakes either (`notification: "inbox"`). The IRC
  session reads it with `stargate_mail` `op: inbox` on its next turn. It reads
  only its own inbox; mail addressed to the member goes to the task
  session as before.
- **Permissions.** Both tools need the `stargate_mail` permission: add
  `{ "action": "stargate_mail", "resource": "*", "effect": "allow" }` after the
  deny rule in the crew registration's `backend.permissions`.
- **Requirements.** An OpenCode captain and crew on the same OpenCode
  server (`backend.url`), a pinned captain session, and a crew IRC
  `backend.directory` equal to the member's worktree. Pi Durable, Claude
  and Codex crew IRC registrations get no crew tools. The captain's own IRC
  conversations run in the pinned captain session, which already has the
  captain's tools.

#### stargate_dm as IRC DMs

With `"crewMessaging": { "ircCopies": true }` (default off), every
`stargate_dm` between two members of this ship that both have IRC connections
here is also sent as a real IRC DM, so Ergo stores it with the other DMs
and the [DM audit](#dm-audit) mirror shows it. The native delivery does
not change; the IRC DM is a copy.

- **Path.** The crew plugin records each stored `stargate_dm` (never plain
  `stargate_mail`) in a bounded outbox (24 hours, 1000 entries). The ship polls
  it every 2 seconds through the `stargate.crew.irc` `outbox` RPC at the
  captain location, from a cursor in Stargate's SQLite store; the first read
  only sets the cursor, so older messages are not copied. Items go out one
  at a time and in order. An entry older than 24 hours is never listed or
  sent, even after a longer Stargate downtime or retries.
- **Delivery.** The sender's IRC connection sends `[stargate_dm] <text>` as
  PRIVMSG to the nick that WHOIS shows holds the recipient's account (as
  for DM replies), rechecked at each socket write. Each line carries the
  client tag `+stargate/dm=<receipt ID>`, the Mesij receipt ID, which is stable
  across retries. A copy that cannot be sent yet (connection down,
  recipient offline) holds the cursor and is retried for 10 minutes, then
  skipped with a warning. A member without an IRC connection here, or a
  server without `message-tags`, gets no copy.
- **Text.** Plain text, at most 1800 bytes, then `… (truncated; full text
  in stargate_mail)`. Text that may carry a credential (the same rules as the
  DM audit, CTCP parts included) is not copied: the copy reads `[stargate_dm <id>: not copied to
  IRC, it may contain credentials. Read it with stargate_mail.]`.
- **Dedupe.** Stargate records each receipt ID before it sends the copy
  (7 days). On the receiving connection, a DM from a ship account with a
  recorded `+stargate/dm` ID is never admitted as a turn (the native delivery
  already reached the recipient), never answered by `dmPolicy: "redirect"`,
  and mirrored only once, as the sender's outgoing DM. A DM from a ship
  account with an unknown or no ID follows the existing ship-agent rules
  and caps.
- **Peers.** `stargate_dm` addresses only this team's captain and crew, so
  there are no copies to peer captains of other ships; their IRC DMs keep
  the peer rules.

## Captain instructions

Generated captain definitions include an "IRC messages" paragraph that
explains `s=irc`, `;k=crew`, all-calls, plain text and the response policy.
Generated crew definitions include an "IRC sessions" paragraph. A definition
generated before these features does not contain them: add them, as for
other instruction changes.

## Implementation

`src/transports/irc/client.ts` is a small client on Bun's TCP/TLS sockets, not a
library. The maintained JavaScript option, `irc-framework`, targets Node
`net`/`tls`, lists `labeled-response` and message IDs outside its stable
support, and owns reconnect and SASL internally behind an untyped event
API. Stargate needs per-line delivery confirmation, AbortSignal shutdown,
fail-closed account checks and no new dependency; the protocol subset is
small. Parsing and serialization (`protocol.ts`) refuse any parameter that
would inject a line or a parameter.

Crew IRC sessions are additional OpenCode root sessions (one per member
and channel). Stargate's session title marks them `(irc #channel)`. They use
the crew `backend.permissions`, which default to deny-all tools, and the
model of their agent definition. Nightly model upgrades do not switch them.

## Limits

- Catch-up needs `draft/chathistory` and the server's own history: what the
  server did not keep (or older than `catchUpHours`) is not replayed. A
  channel replay is capped at 100 messages per connect.
- Replies and Stop reactions to bot messages are recognised only for message
  IDs seen since the process started; a reaction to the request itself
  always works.
- Only channel names that start with `#` or `&` are supported. JOIN
  commands are split so each line stays within 512 bytes.
- The fleet dashboard lists Slack registrations only. A captain pinned on
  both transports shows its IRC turns in that shared session's history;
  IRC queue counts and crew IRC sessions are not listed.
- See also [not available on IRC](#not-available-on-irc).
- Exactly-once delivery is not guaranteed: a line or batch whose
  confirmation is lost (or a crash after the server accepts it) can repeat.

## Tests

`tests/irc-*.test.ts` use a local fake IRCv3 server on a loopback socket.
`tests/irc-ergo.test.ts` runs a temporary Ergo server with a throwaway CA,
TLS, SASL accounts and an invite-only channel when
`~/.local/share/ergo/current/ergo` (or `STARGATE_ERGO_BIN`) and `openssl` exist,
and is skipped otherwise. It never uses the operator's server or accounts.

Run the disposable clarification fixture with a local OpenCode 2.2.7 binary:

```sh
mise exec -- bun scripts/irc-question-smoke.ts /path/to/opencode
mise exec -- bun scripts/irc-question-smoke.ts /path/to/opencode --lose-answer-ack
mise exec -- bun scripts/irc-question-smoke.ts /path/to/opencode --drop-answer
```

The fixture uses a loopback model and IRC server. It starts with an open native
form, restarts the gateway after the operator sees it, and checks the native
answer and submission count on the original input.
