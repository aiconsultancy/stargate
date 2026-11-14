# IRC transport

Pogo can reach a captain over IRCv3 as well as Slack. One process can run
Slack bots and IRC registrations together; neither depends on the other.
An IRC registration has its own connection, access rules, queue namespace
and delivery. It reuses the gateway's SQLite queue, outbox, delivery
cursor, transcript catch-up and no-replay rules.

Pogo does not start, configure or administer the IRC server. Account,
channel and TLS setup belong to the server operator.

## Operator steps

1. On the IRC server, create one SASL account for the captain and one per
   crew member (Ergo: `/NICKSERV SAREGISTER <name> <password>` as an
   operator). Register the ship channel with the captain as founder.
2. Put each password in `<config>.env` (mode `0600`) under the variable
   named by its `passwordEnv`. Never put it in `pogo.json` or chat.
3. Add the `irc` registration. For a captain that is also on Slack, copy
   the Slack bot's OpenCode `url`, `directory`, `agent` and `sessionID`;
   the pinned session must match that directory and agent.
4. Optional: give crew a lasting invite exception on an invite-only ship
   channel (see [channels](#channels)); otherwise the captain invites them.
5. Optional: create the [DM audit](#dm-audit) channel.
6. Run `pogo config check --config <path>`, then restart for connection changes.
   Access/transcription and IRC crew additions/idle removals can use
   [SIGHUP reload](../README.md#reload-configuration-without-restarting).
7. Regenerate or edit the captain definition so it contains the
   "IRC messages" paragraph (see [captain instructions](#captain-instructions)).

## Server expectations

Pogo is tested against [Ergo](https://ergo.chat) 2.19. Any IRCv3 server
works if it offers these capabilities:

| Capability                        | Need        | Use                                              |
| --------------------------------- | ----------- | ------------------------------------------------ |
| `sasl` (PLAIN)                    | required    | Log in to the configured account                 |
| `account-tag`                     | required    | Identify every sender by account                 |
| `message-tags`, `server-time`     | recommended | Message IDs, reply tags, times                   |
| `batch`, `labeled-response`       | recommended | Confirm each sent line                           |
| `echo-message`                    | recommended | Own message IDs for reply triggers               |
| `account-notify`, `extended-join` | optional    | Nick hints for direct replies; WHOIS confirms    |
| `draft/chathistory`               | optional    | Fetch channel messages missed during a reconnect |

Without `sasl` PLAIN or `account-tag`, Pogo refuses the server and retries
after five minutes. Without `labeled-response`, a line counts as sent when
it is written to the socket.

Every account must log in with SASL. Pogo never creates accounts. With
Ergo, `force-nick-equals-account` keeps each nick equal to its account, and
`multiclient` lets a reconnect take over the nick.

### Optional features

Pogo uses each of these only when the server offers it. A switch under
`irc[].features` turns one off; every switch defaults to `true`.

| Server offers                                                                   | Switch       | Pogo then                                                                                                                                                                                            |
| ------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `soju.im/FILEHOST` or `draft/FILEHOST` (ISUPPORT), or `server.filehostOverride` | `filesIn`    | Downloads FILEHOST links in admitted messages as attachments ([files](#files))                                                                                                                       |
| the same FILEHOST                                                               | `filesOut`   | Uploads published reply files and posts one link line each ([files](#files))                                                                                                                         |
| `draft/multiline` (with `batch`)                                                | `multiline`  | Sends each reply chunk as one batch within `max-bytes`/`max-lines`, continues long lines with `draft/multiline-concat`, and reads incoming batches as one message                                    |
| `message-tags` (client tags pass through)                                       | `typing`     | Sends `+typing=active` every 3 s while a turn runs and `+typing=done` before the reply, in channels and direct messages                                                                              |
| `message-tags` (`+draft/react`, `+draft/reply`)                                 | `reactions`  | Sends reaction replies as `+draft/react`; a person reacting with a `stopReactions` emoji (default ✋, 🛑) on a request or its bot answer stops the active turn ([Stop](#stop-by-reaction))           |
| `draft/chathistory` (with `batch`, `server-time`)                               | `catchUp`    | On each (re)connect replays missed channel messages (`AFTER`) and direct messages (`TARGETS`, then `AFTER`) from a cursor stored in SQLite, at most `catchUpHours` (24) back ([catch-up](#catch-up)) |
| `draft/persistence`                                                             | `alwaysOn`   | Sends `PERSISTENCE SET ON` after each connect: the server keeps the account in its channels and stores direct messages while Pogo is away ([presence](#presence))                                    |
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
    "passwordEnv": "POGO_IRC_GALACTICA_CAPTAIN_PASSWORD",
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
        "passwordEnv": "POGO_IRC_GALACTICA_CHIEF_PASSWORD",
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

| Field                          | Rule                                                                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.host`, `server.port`   | IRC server address                                                                                                                                                                                                              |
| `server.tls`                   | `false` only for `127.0.0.1` or `::1`                                                                                                                                                                                           |
| `server.caFile`                | Absolute PEM path of a private CA; TLS only                                                                                                                                                                                     |
| `server.network`               | Optional ISUPPORT `NETWORK` name, for example `Fleet`; another name is refused                                                                                                                                                  |
| `account`, `passwordEnv`       | SASL PLAIN account and the environment variable with its password                                                                                                                                                               |
| `nick`                         | Optional; defaults to the account                                                                                                                                                                                               |
| `channels`                     | The only channels the captain joins and answers in; at most 20, each at most 50 bytes                                                                                                                                           |
| `access`                       | See [access](#access)                                                                                                                                                                                                           |
| `crew`                         | See [crew](#crew-on-irc); at most 20                                                                                                                                                                                            |
| `backend`                      | Any backend; OpenCode can pin the captain `sessionID`                                                                                                                                                                           |
| `concurrency`, `turnTimeoutMs` | As for Slack bots (defaults 4 and 30 minutes)                                                                                                                                                                                   |
| `server.filehostOverride`      | Optional FILEHOST upload URL when the server does not advertise one ([files](#files))                                                                                                                                           |
| `features`                     | Switches for [optional features](#optional-features); each defaults to `true`                                                                                                                                                   |
| `stopReactions`                | Emoji that stop a turn ([Stop](#stop-by-reaction)); default `["✋", "🛑"]`, at most 10, `[]` is off                                                                                                                             |
| `catchUpHours`                 | Longest [catch-up](#catch-up) window, 1–168 hours (default 24)                                                                                                                                                                  |
| `transcription`                | Audio transcription for FILEHOST audio files, as for Slack bots ([files](#files))                                                                                                                                               |
| `audit`                        | Optional `{ "channel": "#agent-dms" }`: mirror every agent DM to that channel ([DM audit](#dm-audit))                                                                                                                           |
| `crewMessaging`                | `{ "sessions": false, "ircCopies": false }`: crew IRC sessions may use `pogo_dm`/`pogo_mail`; `pogo_dm` is also sent as an IRC DM ([crew sessions](#pogo_dm-and-pogo_mail-in-crew-irc-sessions), [copies](#pogo_dm-as-irc-dms)) |
| `dmPolicy`                     | `agent` (default: the captain answers DMs) or `redirect` ([DM audit](#dm-audit))                                                                                                                                                |

### Naming

The examples use this naming rule for a ship `<ship>`:

| Name                 | Rule             | Example             |
| -------------------- | ---------------- | ------------------- |
| Ship channel         | `#ship-<ship>`   | `#ship-galactica`   |
| Captain account/nick | `<ship>-captain` | `galactica-captain` |
| Crew account/nick    | `<ship>-<crew>`  | `galactica-chief`   |

Pogo does not enforce the rule: the server operator assigns names, and
peer captains stay an explicit list (see [peer captains](#peer-captains)).
The rule makes ship accounts easy to grant with one invite exception mask
such as `galactica-*!*@*`.

Put passwords in the private `<config>.env` companion or the service
environment, never in JSON. Every account needs its own `passwordEnv`.
`pogo config check` validates the schema, checks that each password
variable is set and that `caFile` is a file. It does not connect.

For the TLS listeners, use the server's private CA:

```json
"server": {
  "host": "10.23.45.1",
  "port": 6697,
  "tls": true,
  "caFile": "/home/operator/.local/state/ergo/tls/ca.pem"
}
```

Pogo verifies the certificate against that CA and the host name or IP.

The namespace of each IRC connection includes the server host, port and
`network` name, the registration ID, the account and the backend settings.
Moving a registration to another host, port or network therefore starts new
queues, outboxes and unpinned sessions; a pinned captain keeps its native
session but starts a new delivery cursor at current history. Set `network`
so a server that announces another network is refused before Pogo joins
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

`access.peerTurnsPerHour` overrides the default five peer-captain turns per
conversation/hour (0–600; 0 refuses them). It reloads live with the other access
settings and `shipTurnsPerAgentPerHour`.

- The sender's identity is the IRCv3 `account` tag, never the nick. A
  message without an account tag is ignored.
- Any logged-in account may write to the captain, unless
  `deniedAccounts` lists it. `*` denies everyone.
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

A direct message to the captain always starts a turn. Crew connections
ignore direct messages. With `dmPolicy: "redirect"`, no direct message
starts a turn (see [DM audit](#dm-audit)).

Access rules are request filters, not isolation. Every logged-in account
on the server can drive the captain's enabled tools.

### Peer captains

`access.peerCaptains` lists the accounts of other fleet captains. The list
is explicit; a naming rule such as `*-captain` is not used, because the
server operator assigns account names and an explicit list cannot match by
accident. Peer messages follow the Slack peer rules: the source line ends
with `;k=captain`, they carry no operator or Admiralty authority, and Pogo
admits at most **5 per conversation (channel or direct message) in a
rolling hour**. A peer list cannot contain this ship's own accounts.

## Conversations

| IRC             | Pogo conversation                   |
| --------------- | ----------------------------------- |
| Channel message | One conversation per channel        |
| Direct message  | One conversation per sender account |

A pinned captain uses its one session for all of them. Each turn carries a
source line:

```text
s=irc;c=%23ship-galactica;t=<msgid>;m=<msgid>;u=jack[;k=crew|captain]
```

Unpinned sessions (crew, Pi Durable) get a one-line note instead, for
example `[IRC #ship-galactica, from account jack. IRC shows plain text only.]`.
New sessions use the title `<name> (irc <channel>)`.

Turns in one conversation run in order. IRC message IDs deduplicate a
message that arrives twice, for example from a history replay.

## Replies

- Agent Markdown becomes plain text: headings, emphasis, fences and table
  rules are removed; links keep their URL; inline code keeps its backticks.
  Control characters are removed, so a reply cannot send CTCP or IRC
  formatting.
- Each line fits 512 bytes, including Pogo's tags and the source prefix
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
- The first line (or batch) carries `+draft/reply` to the request's message.
- A direct reply goes only to a nick that WHOIS (`330`) shows is logged in
  to the requester's account at that moment: the last nick seen for the
  account, then the account name. A nick with another account, or none,
  never receives it; the delivery fails and retries later. Account/nick
  hints are dropped on QUIT, NICK, PART, KICK, logout and reconnect. Each
  direct line is checked again when it is written to the socket, after the
  send throttle: if the binding was dropped meanwhile, the queued line is
  discarded and the stored reply waits for a retry. A nick that changes
  hands with no event Pogo can see (no shared channel) after the WHOIS is
  not detected for that chunk.
- Sends are throttled: a burst of 4 lines, then one line every 600 ms.
- While a turn runs, Pogo sends `+typing=active` (TAGMSG) every 3 seconds
  and `+typing=done` before the reply. Typing is skipped while replies wait
  in the send queue, so it never delays them. In a direct message it goes
  only to a nick that WHOIS shows holds the requester's account, checked
  again for each TAGMSG and at the socket write, as for reply lines; once
  the nick changes hands, typing stops for that turn.
- With `labeled-response`, each line waits for the server's labeled echo or
  `ACK`; a labeled error fails the delivery. A line that is still in the
  send queue at the confirmation deadline (20 seconds) is removed and never
  written later, so a delivery that already failed cannot send it twice.
- `[[pogo:silent]]` posts nothing. `[[pogo:react:NAME]]` sends a
  `+draft/react` TAGMSG to the request's message.
- A reply is stored before delivery. A failed delivery retries the stored
  chunk later and never reruns the agent. Pogo stores how it split each
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
variation selector are ignored; `[]` turns Stop off). Pogo then cancels the
turn exactly like Slack Stop: the cancel signal reaches the backend, the
"stop request" notice is posted, and tool effects are not rolled back.
Only people can stop a turn: the reaction needs an account tag, must pass
the deny lists and channel rules, and this ship's own accounts and peer
captains are ignored. Any admitted person in the conversation can stop it,
not only the requester. A reaction to the request stops every ship agent
working on it (for example after an all-call). `+draft/unreact` is ignored:
a Stop cannot be undone.

### Not available on IRC

- **Edits and deletion.** Pogo never edits or deletes an IRC message, so
  there are no streaming previews, waiting messages, activity boxes or
  cancellable maintenance notices. A captain tool that needs a cancellable
  notice stays fail-closed on IRC.
- **Redaction.** `draft/message-redaction` is not used: Ergo ships with
  redaction disabled. The extension point is the optional `remove` method
  of the delivery interface (`SlackDelivery.remove` in `src/gateway.ts`),
  which `IrcDelivery` does not implement; a `REDACT <target> <msgid>`
  version would go there, used only when the server offers the capability.
- **Buttons and interactive controls.** Stop is a reaction
  ([Stop by reaction](#stop-by-reaction)); there is no Stop button.
- **Undo of Stop.** `+draft/unreact` is ignored.
- **Files without a FILEHOST.** Files move only through a FILEHOST (see
  [files](#files)); without one, a published file posts a short
  "attachment is unavailable" notice.
- **Slash commands.** No `/cron`, `/pogo` commands or scheduled prompts.

## Files

Ergo can advertise a FILEHOST: an upload URL in ISUPPORT
(`soju.im/FILEHOST` or `draft/FILEHOST`, see the
[spec](https://github.com/emersion/soju/blob/master/doc/ext/filehost.md)).
Set `server.filehostOverride` to the same upload URL when the server does
not advertise it. When both exist with different origins, Pogo turns files
off and logs one warning. The URL must be HTTPS; plain HTTP is accepted only
on `127.0.0.1`/`::1` and only when the IRC connection is plaintext.

**Files in** (`features.filesIn`): a link in an admitted message whose
origin is exactly the FILEHOST origin becomes an attachment, as for Slack
files (at most 10). Links to any other host stay text and are never
fetched. Pogo downloads with HTTP Basic and the registration's own SASL
account and password, refuses redirects, verifies TLS with `server.caFile`,
and applies a 30-second timeout and the attachment limits (10 MiB a file,
25 MiB in total). HTML, XHTML and SVG (declared or detected) reach the
backend as `text/plain` source, never as a renderable page. Audio and video
use the same path as Slack voice notes: with `irc[].transcription` (same
settings as for Slack bots, without `spokenMentions`), Pogo replaces them
with a transcript; without it, they go to the backend as files. A download
failure ends the turn with the attachment failure notice, as on Slack.

**Files out** (`features.filesOut`): files that the agent publishes with
`![caption](file:///absolute/path)` (the Slack path, see
[attachments](attachments.md)) are uploaded to the FILEHOST with the same
credentials (`POST`, `Content-Type`, `Content-Disposition` with the file
name), after the reply text. Pogo then posts one line per file,
`caption: URL`. The upload's `Location` must be on the FILEHOST origin and
carry no user name or password; any other answer makes the file
unavailable, and Pogo never posts such a URL. The FILEHOST serves uploaded HTML sandboxed and renders
Markdown, so `.html` and `.md` links open as pages. Upload is part of
delivery, and Pogo never repeats an upload that may have stored the file:
it records "uploading" before the `POST` and the returned URL before the
link line. A retry posts a recorded URL without uploading again. When an
upload had no certain outcome (Pogo stopped, the answer was lost, it timed
out, the FILEHOST answered `429`, a `5xx` or another unexpected status, or
a `201` without a usable `Location`), the file becomes unavailable and Pogo
posts the "attachment is unavailable or its upload is unconfirmed" notice;
the FILEHOST may then hold an unlinked copy. Only a proven refusal (`400`,
`401`, `403`, `413` or `415`), after which the FILEHOST holds nothing, is
tried again. A crash between the post and the record
can repeat only the link line. Without a FILEHOST, or with `filesOut` off,
Pogo posts the existing "attachment is unavailable" notice.

## Connection

- CAP 302 negotiation, then SASL PLAIN, then `CAP END`.
- Keepalive: Pogo sends PING after 60 seconds of silence and reconnects
  after 150 seconds without data. Server PINGs are answered at once.
- Reconnects use exponential backoff from 1 second to 2 minutes, with
  jitter. A refused login or a server without required capabilities waits
  5 minutes.
- If the nick is taken, Pogo uses `<nick>_` and retries the configured nick
  every 30 seconds.
- Catch-up with `draft/chathistory`: see [catch-up](#catch-up).
- Shutdown sends `QUIT` and closes every connection before workers drain.
- IRC connection failures never stop Slack or Pogo startup; they retry in
  the background.

## Catch-up

With `draft/chathistory` (and `features.catchUp`), each IRC connection
keeps cursors in SQLite: the newest server time it has seen in each of its
channels and with each direct-message partner (by nick), plus a
direct-message baseline set on the first start. A cursor moves only after
a message has been stored or refused, so a stop between the two replays
it. Each partner has its own cursor, so one partner's newer message never
skips another partner's older ones. On every connect and reconnect Pogo
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
start without a cursor, Pogo sets the cursor to now and replays nothing, so
an existing backlog is not answered. Replayed reactions never stop a turn.

## Presence

Each IRC connection (captain and crew) uses these when the server offers
them:

- **Always-on** (`draft/persistence`, switch `alwaysOn`): after each connect
  Pogo sends `PERSISTENCE SET ON`. On Ergo an always-on account stays in its
  channels and keeps receiving direct messages (stored for later) while
  Pogo is stopped or disconnected; with [catch-up](#catch-up) Pogo then
  reads what it missed. Ergo allows this only when
  `accounts.multiclient.always-on` is `opt-in` (or `opt-out`); otherwise
  the server refuses it and Pogo logs the `PERSISTENCE STATUS` it gets.
  Always-on stays set on the server after Pogo stops; turn it off with
  `PERSISTENCE SET DEFAULT` from another client of the account.
- **Bot mode** (ISUPPORT `BOT`, switch `botMode`): Pogo sets that user mode
  (Ergo: `+B`) on its nick after each connect. Clients can show the account
  as a bot.
- **Read marker** (`draft/read-marker`, switch `readMarker`): after a
  message is accepted (stored as a turn), Pogo sends `MARKREAD` with the
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
[dm 2026-11-14T10:42Z] jack → galactica-captain: sent while Pogo was down
```

**What is mirrored**

- Incoming: every PRIVMSG and NOTICE from a user to the nick of the captain
  or of a crew connection, whether or not it starts a turn.
- Outgoing: every PRIVMSG and NOTICE that a ship connection sends to a nick
  and the server confirms: agent replies, Pogo's own notices (for example
  "attachment unavailable" or the stop notice), FILEHOST link lines and
  `dmPolicy` redirects.
- The sender or recipient shows as its nick. When its account differs, the
  account follows in parentheses; `(no account)` marks a user who is not
  logged in. The agent shows as its account.
- A message that [catch-up](#catch-up) replays (it arrived while Pogo was
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
  operator logged in as the captain account): Pogo does not see them as
  sent. Ergo's stored DM history (see below) has them.

**Rules**

- The audit channel is never a conversation: no message in it starts a
  turn (mentions, all-calls and replies included), no reaction in it stops
  one, and catch-up never replays it. Pogo never mirrors what it posts
  there, so the mirror cannot loop. `config check` refuses an audit channel
  that is a captain or crew channel of this registration, or a ship channel
  of any other IRC registration, on any server: host names and ports do not
  prove two servers distinct. The comparison uses one key that is at least
  as coarse as every CASEMAPPING Pogo knows (`widestFold` in
  `src/irc/protocol.ts`, built on the runtime `unicode` fold): Unicode
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
  both count as dropped. Pogo logs one warning with the count at most every
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
| Entry attribution       | Pogo's text (`[dm] galactica-chief → …`)                 | The server's source nick as well        |
| Captain offline         | Crew entries wait in the queue (or drop when it is full) | Each connection posts on its own        |
| Send rate               | Shares the captain's throttle (low priority)             | Each connection's throttle              |

Attribution in the chosen design comes from Pogo's text, not from the
poster's account. That is acceptable because only Pogo posts the entries,
and Ergo's stored DM history keeps the authoritative copy.

**Redirect policy**

`"dmPolicy": "redirect"` (default `"agent"`) stops agents from acting on
DMs. No DM starts a turn. Every connection, captain and crew, answers a DM
from a logged-in account with a NOTICE, `Please ask in #ship-galactica`
(its first channel); a DM without an account gets no answer, so rotating
nicks cannot make Pogo flood. The mirror still records every DM and
answer. Pogo answers each account at most once every 5 minutes per
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
  mirror shows DMs while Pogo runs; the server keeps all of them.
- `audit` and `dmPolicy` changes need a restart; SIGHUP reload refuses them.

## Crew on IRC

Each crew member can have its own IRC account, for example
`galactica-chief`, with its own `passwordEnv`. The operator creates these
accounts.

### Channels

- A crew connection joins only the channels in its `crew[].channels`. That
  list must be a subset of the captain's `channels` and currently has
  exactly one entry: the ship channel. `config check` compares these names
  exactly, up to ASCII letter case only, so `#ship{1}` is not `#ship[1]`.
  At runtime the crew connection also requires each channel to be a
  captain channel under the server's `CASEMAPPING`; otherwise it never
  joins, answers or delivers there.
- Pogo ignores an INVITE to any other channel and leaves a channel that
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
session that the crew plugin manages. Pogo refuses a crew backend with a
pinned `sessionID`. A crew member can also run on Claude Code with a
`claude` backend, or on the Codex CLI with a `codex` backend; see the
Galactica examples for [Claude](claude.md#set-up-through-cliproxyapi) and
[Codex](codex.md#set-up-through-cliproxyapi).

Reason: the crew plugin reads a task result from the final answer that
follows the task's input. An outside input after it makes the result
unreadable ("A later input follows this task"). The crew plugin's DM path
also cannot carry a reply back to IRC. Separate IRC sessions keep the task
model intact and need no crew plugin change. To hand IRC work to a crew
member's task session, the captain uses `pogo_crew` as usual.

### Crew-to-crew messages

A crew member hears a ship channel message that mentions its nick, replies
to one of its messages, or is an all-call. It does not see other channel
traffic. The sender can be a person, the captain or another crew member. A message from any of this ship's accounts (captain or
crew) is a **ship message**:

- the pinned captain sees `;k=crew`; crew sessions see a note that the
  sender is a ship account and that acknowledgements need
  `[[pogo:silent]]`;
- An all-call from a ship account counts once for each agent it reaches,
  like other ship messages; an all-call from a person is not limited by
  this cap.
- Pogo admits at most `access.shipTurnsPerAgentPerHour` (default 60,
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
`IrcShip` (`src/irc/ship.ts`): a runtime grant set beside
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

Otherwise it answers `[[pogo:silent]]` and Pogo posts nothing. For an
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
  most 300 characters), and tells it to answer `[[pogo:silent]]` if one
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
gives crew work or information with `pogo_dm` (a reply is needed now),
`pogo_mail` (no reply is needed now) or `pogo_crew`. A crew member reaches
the captain in the ship channel, or with `pogo_dm` to `captain` from its
task session, and reaches another crew member with `pogo_dm` or `pogo_mail`
from its task session. An agent tags another crew member on IRC only when a
person or the captain asks for it in that channel, or to correct an error.
The mention/reply mechanism and the ship message limit stay in force; this
is guidance, not a hard block.

#### pogo_dm and pogo_mail in crew IRC sessions

With `"crewMessaging": { "sessions": true }` (default off), Pogo binds each
crew IRC session to its crew member in the crew plugin, so `pogo_dm` and
`pogo_mail` work there as that member:

- **Binding.** Before each turn of a crew IRC session, once per process,
  Pogo calls the crew plugin's `pogo.crew.irc` `bind` RPC at the captain
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
  (`pogo_crew`, `pogo_journal`, …) still refuse IRC sessions.
- **No task.** An IRC session never has a task, not even its member's
  current one: `taskID` is refused, and its mail carries the pinned
  captain as its captain context. Self-sends to its own member are refused,
  so it never prompts that member's task session.
- **Sending.** `to: captain` stores the mail and wakes the captain as any
  `pogo_dm` does. `to: <crew>` goes to that member's task session under the
  existing wake rules: a busy task keeps its result rule ("your final
  answer remains task X's result"), and a task for another captain defers.
- **Replies and inbox.** A reply (`replyTo`) to a message an IRC session
  sent goes back to that IRC session's own inbox, never to the member's
  task session, and never wakes either (`notification: "inbox"`). The IRC
  session reads it with `pogo_mail` `op: inbox` on its next turn. It reads
  only its own inbox; mail addressed to the member goes to the task
  session as before.
- **Permissions.** Both tools need the `pogo_mail` permission: add
  `{ "action": "pogo_mail", "resource": "*", "effect": "allow" }` after the
  deny rule in the crew registration's `backend.permissions`.
- **Requirements.** An OpenCode captain and crew on the same OpenCode
  server (`backend.url`), a pinned captain session, and a crew IRC
  `backend.directory` equal to the member's worktree. Pi Durable, Claude
  and Codex crew IRC registrations get no crew tools. The captain's own IRC
  conversations run in the pinned captain session, which already has the
  captain's tools.

#### pogo_dm as IRC DMs

With `"crewMessaging": { "ircCopies": true }` (default off), every
`pogo_dm` between two members of this ship that both have IRC connections
here is also sent as a real IRC DM, so Ergo stores it with the other DMs
and the [DM audit](#dm-audit) mirror shows it. The native delivery does
not change; the IRC DM is a copy.

- **Path.** The crew plugin records each stored `pogo_dm` (never plain
  `pogo_mail`) in a bounded outbox (24 hours, 1000 entries). The ship polls
  it every 2 seconds through the `pogo.crew.irc` `outbox` RPC at the
  captain location, from a cursor in Pogo's SQLite store; the first read
  only sets the cursor, so older messages are not copied. Items go out one
  at a time and in order. An entry older than 24 hours is never listed or
  sent, even after a longer Pogo downtime or retries.
- **Delivery.** The sender's IRC connection sends `[pogo_dm] <text>` as
  PRIVMSG to the nick that WHOIS shows holds the recipient's account (as
  for DM replies), rechecked at each socket write. Each line carries the
  client tag `+pogo/dm=<receipt ID>`, the Mesij receipt ID, which is stable
  across retries. A copy that cannot be sent yet (connection down,
  recipient offline) holds the cursor and is retried for 10 minutes, then
  skipped with a warning. A member without an IRC connection here, or a
  server without `message-tags`, gets no copy.
- **Text.** Plain text, at most 1800 bytes, then `… (truncated; full text
  in pogo_mail)`. Text that may carry a credential (the same rules as the
  DM audit, CTCP parts included) is not copied: the copy reads `[pogo_dm <id>: not copied to
  IRC, it may contain credentials. Read it with pogo_mail.]`.
- **Dedupe.** Pogo records each receipt ID before it sends the copy
  (7 days). On the receiving connection, a DM from a ship account with a
  recorded `+pogo/dm` ID is never admitted as a turn (the native delivery
  already reached the recipient), never answered by `dmPolicy: "redirect"`,
  and mirrored only once, as the sender's outgoing DM. A DM from a ship
  account with an unknown or no ID follows the existing ship-agent rules
  and caps.
- **Peers.** `pogo_dm` addresses only this team's captain and crew, so
  there are no copies to peer captains of other ships; their IRC DMs keep
  the peer rules.

## Captain instructions

Generated captain definitions include an "IRC messages" paragraph that
explains `s=irc`, `;k=crew`, all-calls, plain text and the response policy.
Generated crew definitions include an "IRC sessions" paragraph. A definition
generated before these features does not contain them: add them, as for
other instruction changes.

## Implementation

`src/irc/client.ts` is a small client on Bun's TCP/TLS sockets, not a
library. The maintained JavaScript option, `irc-framework`, targets Node
`net`/`tls`, lists `labeled-response` and message IDs outside its stable
support, and owns reconnect and SASL internally behind an untyped event
API. Pogo needs per-line delivery confirmation, AbortSignal shutdown,
fail-closed account checks and no new dependency; the protocol subset is
small. Parsing and serialization (`protocol.ts`) refuse any parameter that
would inject a line or a parameter.

Crew IRC sessions are additional OpenCode root sessions (one per member
and channel). Pogo's session title marks them `(irc #channel)`. They use
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
`~/.local/share/ergo/current/ergo` (or `POGO_ERGO_BIN`) and `openssl` exist,
and is skipped otherwise. It never uses the operator's server or accounts.
