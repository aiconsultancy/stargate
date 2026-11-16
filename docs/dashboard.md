# Fleet dashboard

The dashboard is a read-only web page for the operator. It shows every bot
registration in one Stargate process as a ship, including Slack, IRC captains
and crew, and Teams:

- the captain and crew, with current, queued and recent tasks;
- the Stargate registration: its real transport identity, access rules and backend;
- the request queue: totals and recent requests, without prompt text;
- cronjobs: state, next run, last status and recent runs;
- session history for the captain, each crew member and their subagents,
  for OpenCode and Pi Durable sessions.

It starts no model work and changes no session, queue, schedule or file.

## Enable

Add one top-level setting to `stargate.json`, then restart Stargate:

```json
{ "dashboard": true, "bots": [] }
```

Stargate serves the page on a Unix socket, `<dataDirectory>/dashboard.sock`.
The socket has mode `0600` in a directory with mode `0700`. Only the same
operating-system user can connect. There is no TCP listener and no setting
that creates one. A stale socket from an earlier run is replaced; the
instance lock on the data directory proves that no other Stargate owns it.

Startup fails when the socket cannot be created. Later request errors never
stop the gateway.

### Share only the socket with an operator proxy

An explicit optional setting exposes a separate Unix socket to an operator
Unix group while leaving the gateway data directory private:

```json
{
  "dashboard": true,
  "dashboardSocket": {
    "path": "/run/stargate/dashboard/http.sock",
    "groupAccess": true
  },
  "bots": []
}
```

Keep the existing transport registrations alongside these settings. The socket
path must be absolute and normalised, outside `dataDirectory`. An operator must
create its parent directory before startup: owner is the Stargate process user,
group is the proxy's operator group, and mode is exactly `2750`. The setgid bit
assigns that group to the socket; only its owner can write the directory. All
ancestors must be real directories owned by root or the gateway user, without
group/other write access except protected sticky temporary directories.

The listener creates the socket with mode `0660` from the start. It refuses live
listeners, regular files, symlinks and unsafe paths, and removes only its own
socket on shutdown. Gateway users need no membership of the operator group.
Separate per-gateway directories prevent other gateway users from reaching the
sockets. Do not change the data directory's `0700` permissions or give the proxy
access to stores, credentials or agent homes.

Omitting `dashboardSocket` preserves the existing private `0600` socket.
`dashboardSocket` requires `dashboard: true` and a restart; it creates no TCP
listener. The operator group can read full transcripts, so assign it only to a
trusted authenticating proxy. A dashboard connection or proxy login grants no
native tool, approval, message-send or source-control authority.

## Publish through a reverse proxy

A browser cannot open a Unix socket. Put an authenticating reverse proxy in
front of it. Stargate does not authenticate viewers: the proxy must do that.
This Caddy example sits behind Tailscale Serve, admits one Tailscale user
and serves the page below `/stargate/`:

```caddyfile
@stargate path /stargate /stargate/*
handle @stargate {
	@not_owner not header Tailscale-User-Login operator@example.com
	respond @not_owner "Tailscale owner identity required" 403
	redir /stargate /stargate/ 308
	uri strip_prefix /stargate
	reverse_proxy unix//srv/stargate/.stargate/dashboard.sock
}
```

Tailscale Serve removes identity headers that a client supplies and adds its
own. Trust those headers only from a proxy that listens on loopback. The page
uses relative addresses, so any path prefix works. Do not publish the socket
through a proxy without authentication, and do not use Tailscale Funnel.

To read the API without a browser:

```sh
curl --unix-socket /srv/stargate/.stargate/dashboard.sock http://stargate/api/fleet
```

## Transport identities and process scope

Each configured registration has its own dashboard ID and existing queue/session
namespace. An IRC and Teams registration may deliberately share a pinned native
root; they remain separate dashboard registrations and their mapped conversation
histories and queue counts are not combined. The shared pinned root is visible
to both. The dashboard reuses the running backends and connections and starts
no model work. IRC access/roster reloads update the same view; removed crew
registrations disappear after the committed reload.

IRC detail reports server, port, TLS, network, real account/nick, joined channels
and account/channel policy. Teams reports tenant and bot application IDs plus
its configured user/channel policy. Neither invents Slack app or workspace IDs.
Existing Slack detail and its `bot.slack` metadata are unchanged.

The JSON API retains its existing paths. Non-Slack fleet summaries add
`transport: "irc"` or `"teams"`; their detail uses `bot.transport` with the
corresponding `kind` and real identity. `bot.slack` exists only for Slack.

One process shows only its own registrations. For several independent processes,
an authenticating operator proxy can expose one prefixed route per socket. An
external read-only aggregator may combine exact known gateway summaries and route
known registration IDs to fixed protected sockets; Stargate does not discover or
trust arbitrary peers. Keep unavailable gateways explicit and preserve the
owner's history checks, GET/HEAD-only methods, no-store headers and CSP. Do not
forward browser credentials to a native engine or convert dashboard identity
into a new human approval.

## Session history

The Sessions tree lists the captain session, each provisioned crew member
and the bot's other conversations, most recently used first. A session can
show its subagents, which are the child sessions of that session.

A transcript opens in summary detail: user and assistant text, plus the
name and status of each tool call. **Show details** reads the same page
again with reasoning text and tool inputs and outputs. Each detail block
stays closed until you open it.

Full detail can contain file contents, command output and credentials that
an agent read. Use it on a trusted device. Responses are sent with
`Cache-Control: no-store`. Stargate does not store or log transcript text for
the dashboard; it reads each page from the backend on request.

### Scope

A viewer can read a session only when it belongs to that ship:

- the bot's pinned captain session;
- a session that the bot's own queue has used;
- a crew member's session, as recorded by the crew plugin;
- a subagent below one of those sessions, at most eight levels deep.

Other sessions on the same OpenCode server return `404`, including sessions
of another bot. When the crew plugin cannot be read, crew sessions are
refused; access is never widened.

### Harness support

| Backend                | Roots                        | Subagents          |
| ---------------------- | ---------------------------- | ------------------ |
| OpenCode               | Captain, crew, conversations | Child sessions     |
| Pi Durable bot         | Conversations                | None               |
| Pi Durable crew member | The member's conversation    | Recorded task runs |
| Claude bot             | Not available                | Not available      |
| Codex bot              | Not available                | Not available      |
| Module                 | Not available                | Not available      |

Pi crew history is read by the crew plugin in the OpenCode server process,
through the same authenticated captain-location RPC as crew status.

## Routes

All routes accept `GET` and `HEAD` only and return JSON, except `/`.

| Route                                   | Result                    |
| --------------------------------------- | ------------------------- |
| `/`                                     | The page                  |
| `/api/fleet`                            | One summary for each ship |
| `/api/ships/<bot>`                      | One ship in full          |
| `/api/ships/<bot>/sessions?parent=<id>` | Subagents of a session    |
| `/api/ships/<bot>/entries?session=<id>` | One transcript page       |

`entries` also accepts `cursor`, `order` (`asc` or `desc`), `detail`
(`summary` or `full`) and `limit` (1 to 50). Errors are
`{ "error": "..." }` with a fixed text. They never contain exception
details, identifiers or transcript text.

## Limits

- View only. Use Slack, `stargate cron` or `stargate_cron` to change state.
- One Stargate process. Another installation needs its own socket and route.
- Task and queue states are stored states. They do not prove that work is
  live. See [crew activity](crew-activity.md#query-a-member).
- A transcript page has at most 50 entries. One entry shows at most 100
  parts, and one part at most 20,000 characters. The page marks text that
  was cut and counts parts that were left out.
- Pi Durable shows a tool result inside its tool call only when both are on
  the same page. Otherwise the result is a separate entry. Pi forks are not
  listed. A Pi store with an older schema is not read until Pi upgrades it.
- The Sessions tree lists at most 50 gateway roots and says when older
  conversations exist. There is no search; use
  [session history](session-history.md) or
  [knowledge search](knowledge-search.md).
- At most eight API requests run at one time. A request stops after 20
  seconds.
- Full detail is a trusted-operator view. It is not a redaction boundary.
