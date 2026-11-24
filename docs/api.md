# Fleet API v1

Subspace Fleet Console uses the Fleet API to read registrations, crew activity,
and host metrics. The API can start independently of the
[Unix-socket dashboard](dashboard.md). It does not start agent work or change
sessions, queues, or schedules.

## Enable

Add the top-level `api` object to your existing `stargate.json`, alongside your
transport registrations.

```json
{
  "api": {
    "listen": "127.0.0.1:8484",
    "allowedNetworks": ["127.0.0.0/8"],
    "fleetName": "Example fleet"
  }
}
```

Run `stargate config check` and restart Stargate. A bind failure prevents
startup. Omit `api` to turn the listener off. A fleet's
[officers](#officers) read the API on their own sockets, with or without it. Use `:8484` to select the default
loopback host, or `[::1]:8484` for IPv6 loopback. See the
[configuration reference](configuration.md#fleet-api) for all settings and
defaults. Every API setting requires a restart.

The listener is private-network only because fleet and host metadata are
operator data. It accepts literal loopback, RFC 1918, CGNAT (including
Tailscale IPv4), and IPv6 loopback and ULA addresses. Public addresses and
wildcard binds such as `0.0.0.0` and `::` are rejected. The CIDR allowlist checks
the TCP peer address. With a local proxy or tunnel, allow its loopback
address and enforce remote-client access at the proxy or tunnel.

### Private Unix mode

Set `"api": { "listen": "unix" }` to serve the same Fleet routes on
`<dataDirectory>/api.sock` instead of TCP. This selects one listener, not an
additional endpoint. Existing private TCP settings keep their meaning.
The Unix mode requires an owner-controlled mode-0700 data directory and creates
the socket with mode 0600. It refuses occupied live sockets, symlinks, foreign
sockets and regular files. Shutdown removes only the socket it published.

The operator bearer is still required. `allowedNetworks` applies only to TCP;
Unix access uses filesystem ownership. Fleet browser-origin rules are unchanged.
Optional [notification inputs](notification-ingestion.md) use separate producer
credentials and exact POST mounts on this Unix owner. Each defaults to off.
Health and configuration routes are not implemented.

To roll back to a version without Unix mode, restore the prior private TCP
`listen` setting, or omit `api` if no Fleet listener is needed. Keep `api-token`
and other private state. Do not remove an existing TCP configuration blindly.

## Officers

A fleet's own officers (its rear admiral and captains) and their crew read
the same Fleet API, the whole fleet and read-only, without the token. Agents
never hold the token. Each officer reads through a Unix socket that only its
own processes can reach: the socket's file permissions are its identity.

The socket is `fleet.sock` in the officer's Subspace socket directory, beside
its signing proxy socket (see [Subspace API agent identity](subspace-agents.md)).
There is no separate switch: the gateway that has `subspaceAgents` enabled
opens one for every officer with a `socketPath`, at
`<directory of socketPath>/fleet.sock`. It does so whether or not the `api`
listener is configured. Without `api`, Stargate opens no TCP listener and
creates no token; the officers' sockets serve the gateway's fleet under its
host name. With `api`, both serve the same fleet, name and pull request
lookups.

| Path                    | Owner, group and mode                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| The officer's directory | The gateway user and the officer's engine group, mode `2750` (or `0700`), made before the gateway starts |
| `fleet.sock`            | The gateway user and the directory's group (by setgid), mode `0660`; removed when the gateway stops      |

The directory follows the rules of the officer's Subspace socket
([how the caller is identified](subspace-agents.md#how-the-caller-is-identified)):
owned by the gateway user and writable by it alone, under parents only root
or the gateway user can write. Start-up stops, with a log line naming the
officer, when an officer's directory is missing, gives others any access, or
admits a group that another officer's directory also admits, or when the
socket did not get the directory's group. So only the gateway user, root and
members of the officer's engine group can connect. Crew run as their
captain's user and reach their captain's socket; no officer reaches another
officer's.

On the socket:

- only `GET` and `HEAD` are served; every other method gets 405 with
  `Allow: GET, HEAD`, and a request body is never read;
- only the four routes above answer, at exactly normalised targets: no dot
  segment, doubled slash, encoded slash or dot, NUL, backslash or fragment.
  Anything else gets 404. A query is ignored;
- no token is needed and an `Authorization` header is ignored; no browser
  origin is granted CORS;
- answers are the same JSON and event frames as on the operator listener.

Officers' reads and event streams have their own eight HTTP read slots and
eight stream slots, shared by all officers, so officers can never use up the
slots people's consoles need. The host limits below apply to each socket.

Read it with the command, as the officer's user or a crew member's:

```sh
stargate fleet request --socket /run/stargate/subspace/example-captain/fleet.sock /api/v1/fleet
STARGATE_FLEET_SOCKET=/run/stargate/subspace/example-captain/fleet.sock \
  stargate fleet request /api/v1/ships/example-ship/crew/example-member
```

`--socket` defaults to `$STARGATE_FLEET_SOCKET`. The command reads no
configuration. The answer goes to standard output; the exit status is 0 for
a 2xx answer, 1 otherwise (the status goes to standard error), and 2 for a
path that is not a Fleet API path. `/api/v1/events` streams until the
gateway closes it or the command is stopped. `curl --unix-socket` works too:

```sh
curl --fail --silent --show-error \
  --unix-socket /run/stargate/subspace/example-captain/fleet.sock \
  http://localhost/api/v1/fleet
```

## Token

Run `stargate api token [--config PATH]` as the service user. It prints the
bearer token to stdout, creating it if needed. Startup also creates it if
missing. The token is stored in `<dataDirectory>/api-token` with mode
`0600`. Keep it private and enter it in Fleet Console.

Run `stargate api token --rotate [--config PATH]` to replace the token. Restart
Stargate to load the new value and reconnect clients with it. A running
listener continues using the token it loaded at startup.

## Private access from another machine

Keep the bind on loopback for these setups. Stargate serves HTTP. The
tunnel or proxy provides the encrypted client connection, and the bearer
token is still required.

- **Tailscale Serve.** On the gateway host, run
  `tailscale serve --bg http://127.0.0.1:8484`. Point Fleet Console at the
  HTTPS URL Serve reports and use tailnet access rules to limit who can
  connect. Use Serve for tailnet-only access. [Tailscale Serve documentation](https://tailscale.com/docs/reference/tailscale-cli/serve)
- **Cloudflare Tunnel and Access.** Create an Access application for an
  HTTPS hostname such as `fleet.example.com` with an explicit allow policy.
  Route it through a Tunnel to `http://127.0.0.1:8484` and enable Protect with
  Access so the connector verifies the Access token. Keep the Stargate bearer
  in the `Authorization` header. For clients using Access session cookies,
  let Access handle preflight for the exact Space origin and allow
  credentialed CORS on the proxy response. This requires a WebView that
  can send the Access cookie with cross-origin requests.
  [Access-protected applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
  [Access CORS](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/cors/)
- **SSH local forwarding.** From the client machine, run
  `ssh -N -L 127.0.0.1:8484:127.0.0.1:8484 operator@fleet.example.com`
  and connect to `http://127.0.0.1:8484`.

## Browser origins

By default the API allows `subspace://*` for macOS Spaces. On Windows,
add the exact WebView2 Space origin to `corsOrigins`, for example
`["subspace://*", "https://subspace.fleet-console"]`. Use your Space's ID
in the Windows hostname. The `https://subspace.*` pattern also matches
public domains.

Each `*` matches one nonempty label using lowercase ASCII letters, digits,
or hyphens. Include the port when the serialized origin has a port. Matching
origins receive CORS headers on responses, including event streams. An
`OPTIONS` preflight for a matching origin allows `GET`, `Authorization`,
and `Last-Event-ID` without a token.

## Routes

| Route                              | GET response                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| `/api/v1/fleet`                    | Fleet overview with captain summaries, host metrics, and gateway version and features |
| `/api/v1/ships/{id}`               | Ship detail, including crew members                                                   |
| `/api/v1/ships/{id}/crew/{member}` | One member's detail                                                                   |
| `/api/v1/events`                   | Server-sent events                                                                    |

`HEAD` returns headers without a body. Unknown ships, members, and routes
return 404. Missing or invalid tokens receive 401 (officers' sockets need
none). Repeated authentication
failures from a peer receive 429 with `Retry-After`. Responses include
`Cache-Control: no-store`. Times are epoch milliseconds. Host uptime is in
seconds, and CPU usage is a fraction that becomes available after the first
five-second sample interval. The gateway caches the OpenCode V2 server version
for ten minutes. If the probe fails or no OpenCode server is configured, the
value is null.

`host.disks[].path` labels the filesystem. `/` represents the root
filesystem, and `data` represents the filesystem holding the data directory
when it is on a separate device.
`GET /api/v1/fleet` gives the overview and enrichment a shared deadline that
ends one second before the HTTP request deadline (19 seconds by default). If
enrichment times out after the overview is ready, the response uses the latest
host and gateway metrics. Before the first host sample, the
fallback omits disk usage.

Checkout Git status counts changed gitlinks and skips worktree dirt inside
submodules. Status runs in a private Git directory with snapshots of the
primary and shared indexes and access to the checkout's objects. The SHA and
upstream come from the captured branch when attached. Stargate rechecks the
branch and commit after comparing ahead and behind counts and rejects the
snapshot if either changed.

Git status requires the safe metadata opens supported on Linux and macOS.
Other platforms report `Git state unavailable.` The reader checks the size of
each index before snapshotting it. On Linux, it tries a copy-on-write clone
of the open index and streams a bounded copy if cloning is unavailable.
On macOS, it streams a bounded copy.
The primary and shared indexes each have a 128 MiB limit, and all snapshot
metadata has a 192 MiB aggregate limit. Snapshot preparation, including
split-index inspection in a separate process, has a two-second budget before
the two-second Git status and comparison budget starts. A read, including
time waiting for a slot, has a four-second ceiling. A checkout's own timeout
is cached for 15 seconds. Timeouts spent mostly waiting for a read slot are
cached for one read deadline (two seconds). Cleanup runs in the background
within the same concurrency limit. Snapshots use a private
`stargate-git-status` folder in the data directory when the data directory is
outside the worktree, writable and owned by the service user. Every directory
on its path must be owned by root or the service user, and any that other
users can write to must have the sticky bit. Startup removes snapshots there
that are older than 24 hours. Otherwise each process uses its own private
folder in the system temporary directory, which must pass the same path checks
but may be owned by root. That folder is removed when the gateway stops; one
left by a crash is not swept and is cleared with the temporary directory. If
neither directory passes, Git status is reported unavailable.

Copied ignore files, including `core.excludesFile`, must resolve inside
the checkout or the Git directories Git reports for it. Those directories come
from the checkout itself, so this limits which files are copied rather than
forming a hard boundary: a checkout pointed at another repository on the host
can affect its own changed-file count, which can reveal to Fleet viewers
whether that repository's ignore rules match files in the checkout.
The 1 MiB limit applies to each copied pattern file.
Unreadable ignore files are skipped, and `info/exclude` retains its usual
precedence. Git reads worktree `.gitignore` files directly. Status reads
disable filters for safety. Git versions that support `GIT_ATTR_SOURCE`
read attributes from the empty tree and ignore worktree `.gitattributes`.
The private Git directory also has no replacement refs, so a checkout that
relies on `git replace` can show different status counts.
When Git rehashes a racily clean file because its timestamp is too close to
the index timestamp, `text` or `eol` attributes or Git LFS can occasionally
cause an unchanged file to count as changed.

To enable pull request lookups, set `api.pullRequestRepositories` in
`stargate.json` and restart Stargate. Each key is the exact absolute,
normalized path of a local crew checkout as configured in the crew project
registry. Each value is the GitHub `owner/repository` whose PR metadata
you want to share with Fleet API viewers.

```json
{
  "api": {
    "listen": ":8484",
    "pullRequestRepositories": {
      "/srv/crew/example-worktree": "example/project"
    }
  }
}
```

Stargate looks up a branch only in its bound repository and requires the PR
head to belong to that same repository. Checkout remotes supply display
metadata in `git.repository`. The optional legacy fields
`git.pushRepository` and `git.pushRepositoryAmbiguous` are deprecated and
omitted. With no binding or no readable branch and commit, `pullRequest` is
null and `pullRequestKnown` is absent. A context with `pullRequestKnown: true`
and `pullRequest: null` has a settled lookup with no matching PR. A failed
or incomplete refresh retains the last successful lookup result.

## Events

Use a streaming browser `fetch` with an `Authorization` header. A connection
gets a `fleet` event with host and gateway information, followed by the
initial `ship` details. One shared poller reads the overview every three
seconds while clients are connected and publishes a `fleet` event when the
overview or gateway metadata changes, independently of ship details.
In the event stream, overview reads have a 25-second deadline,
and host and gateway enrichment and individual ship details each have a
20-second deadline. Over HTTP, every read ends one second before the request
deadline, so a fallback or an error can still be sent. Within that, `GET
/api/v1/fleet` stops waiting for crew reads 5 seconds before its own deadline
(14 seconds by default) and reports any captain that hasn't answered as
unavailable. The fleet overview, ship detail, and crew detail routes share
eight HTTP read slots. These routes answer 503 when all eight slots are occupied.
When an overview read fails or times out, the poller can republish the last
successful overview with `overviewStale: true` and its original `generatedAt`.
That fallback expires 75 seconds after the successful read and is discarded
when the configured ship roster or a ship's backend identity changes. The
poller also discards in-flight overviews from before the change. On expiry,
the server closes the streams so clients can reconnect for a fresh
snapshot. Once a stream has received a `fleet` frame, a change to the ship
roster or to a ship's backend identity also closes it, and the client
reconnects for a fresh snapshot. Host and
heartbeat events continue while the poller waits for a stalled overview.
At three times a read's deadline, another attempt can start. Each overview,
enrichment, host metrics, crew sample, ship detail and OpenCode `fleetStatus`
probe slot allows one outstanding abandoned read alongside the current
attempt. If the first
overview stalls, host and heartbeat events can arrive before the initial
fleet frame. The host timer waits up to one second for a fresh sample and
uses the latest snapshot if the read is still pending. The snapshot omits
disk usage until the first successful host sample. Changed details emit a
full `ship` event with `detailUpdatedAt`. Reused crew data retains its
observation time, even when other detail changes. Timestamp-only refreshes emit
`ship-sampled` with `id` and `detailUpdatedAt`. Clients can use this event
to update the timestamp on the cached detail. If a refresh fails,
`detailStale` is set to `true` on the last successful detail, which keeps
its original sample time, including across reconnects. When the captain is
unavailable, retained detail reports `available: false` and includes the
current error if supplied. A detail failure
before the first successful detail emits an unavailable `ship` with an
`error` field. A successful refresh clears `detailStale`. An overview
availability transition supersedes in-flight detail reads for that ship.
When a ship becomes available and has no successful detail cached, the
poller waits for a new detail read as the superseded read drains. Removal or a
change of backend identity discards cached detail for that ship. A replacement
backend has its own detail read slot. Availability activity follows the
overview. The stream sends `host` every ten seconds and `heartbeat` every
fifteen seconds.

The overview and ship details share one crew read per ship. When availability
is unknown, the caller waits for that result for up to 20 seconds. During a
refresh, a caller can use a recent sample after one second. A sample up to
23 seconds old at the start of a refresh remains usable until the shared read
completes. A failed sample can also be served with its `error` field set.
A disconnected caller cancels its own wait.
Fleet API shutdown cancels shared crew reads. A committed configuration
reload invalidates cached crew samples and cancels reads for retired backends.
Unchanged backends keep their in-flight reads, including reads shared with
HTTP requests.
After a shared read fails or reaches its deadline, the overview marks the
ship unavailable and retains its last successful crew counts if available.
OpenCode `fleetStatus` probes start with a 400 ms budget that doubles after
a timeout, up to 6.4 seconds, leaving time for ordinary crew status.
Concurrent callers with the same filter share one probe.
An explicit missing-method response or three consecutive failures pause
probes for one minute. Timeouts count toward that pause at the maximum budget.

Activity includes newly observed task outcomes, even if the task also
started between polls. Discovering an existing PR after startup or Git
recovery does not generate activity.

A frame contains an `event:` line, one `data:` line with JSON, and a blank line.

```text
event: heartbeat
data: {"at":1730000000000}

```

Up to eight clients can stream at once. Further connections receive 503,
and streams that fall behind are closed. Reconnect for a new snapshot.
There is no event replay.

## Host limits

The shared HTTP host accepts at most 64 connections. Parsed headers are limited
to 16 KiB and must complete within ten seconds of connection acceptance.
Each connection serves one request and closes after the response. Rejected
requests do not read their bodies. Ordinary Fleet reads have a twenty-second
deadline and eight reserved work slots. Event streams have eight separate
slots, bounded output buffering and a sixty-second idle timeout. Stream
heartbeats continue every fifteen seconds.

Enabled notification routes use separate authorization, no browser
Origin or CORS, at most 64 KiB per body, a twenty-second absolute request
deadline, four work slots per route and eight in total. A timeout aborts the
request but does not release its slot until the handler settles. These slots
cannot consume the Fleet read or stream reservations. Connection limits cannot
guarantee availability against a process-wide pre-header flood.

## Curl

On the gateway host or through the SSH example:

```sh
token=$(stargate api token --config stargate.json)

printf 'Authorization: Bearer %s\n' "$token" |
  curl --fail --silent --show-error --header @- http://127.0.0.1:8484/api/v1/fleet

printf 'Authorization: Bearer %s\n' "$token" |
  curl --fail --no-buffer --header @- http://127.0.0.1:8484/api/v1/events

unset token
```

For Unix mode, replace the URL and add `--unix-socket`:

```sh
token=$(stargate api token --config stargate.json)
printf 'Authorization: Bearer %s\n' "$token" |
  curl --fail --silent --show-error --header @- \
    --unix-socket /absolute/dataDirectory/api.sock http://localhost/api/v1/fleet
unset token
```

### IRC request progress

The IRC captain projection includes up to 16 recent `requests` by default.
Set `irc[].features.liveProgress: false` to omit this field. Entries come from
turns with live status observations. Each entry has the gateway request ID,
a fixed lifecycle stage, observation timestamp, job status, a fixed failure code when applicable, and flags for stale
observations and a disconnected OpenCode event stream. Staleness describes an
active request whose last observation is over a minute old. The Fleet heartbeat
describes the API connection. Request entries exclude question text, private
reasoning, tool arguments, tool results and provider errors.
