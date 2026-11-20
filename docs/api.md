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
startup. Omit `api` to turn the listener off. Use `:8484` to select the default
loopback host, or `[::1]:8484` for IPv6 loopback. See the
[configuration reference](configuration.md#fleet-api) for all settings and
defaults. Every API setting requires a restart.

The listener is private-network only because fleet and host metadata are
operator data. It accepts literal loopback, RFC 1918, CGNAT (including
Tailscale IPv4), and IPv6 loopback and ULA addresses. Public addresses and
wildcard binds such as `0.0.0.0` and `::` are rejected. The CIDR allowlist checks
the TCP peer address. With a local proxy or tunnel, allow its loopback
address and enforce remote-client access at the proxy or tunnel.

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
return 404. Missing or invalid tokens receive 401. Repeated authentication
failures from a peer receive 429 with `Retry-After`. Responses include
`Cache-Control: no-store`. Times are epoch milliseconds. Host uptime is in
seconds, and CPU usage is a fraction that becomes available after the first
five-second sample interval. The gateway caches the OpenCode V2 server version
for ten minutes. If the probe fails or no OpenCode server is configured, the
value is null.

`host.disks[].path` labels the filesystem. `/` represents the root
filesystem, and `data` represents the filesystem holding the data directory
when it is on a separate device.
`GET /api/v1/fleet` gives the overview and enrichment a shared 25-second
deadline. If enrichment times out after the overview is ready, the response
uses the latest host and gateway metrics. Before the first host sample, the
fallback omits disk usage.

Checkout Git status counts changed gitlinks and skips worktree dirt inside
submodules. Status runs in a private Git directory with snapshots of the
primary and shared indexes and access to the checkout's objects. The SHA and
upstream come from the captured branch when attached. Stargate rechecks the
branch and commit after comparing ahead and behind counts and rejects the
snapshot if either changed.

The reader checks the size of each index before snapshotting it. On Linux,
it tries a copy-on-write clone of the open index and streams a bounded copy
if cloning is unavailable. On other platforms it streams a bounded copy.
The primary and shared indexes each have a 128 MiB limit, and all snapshot
metadata has a 192 MiB aggregate limit. Snapshot preparation, including
split-index inspection in a separate process, has a two-second budget before
the two-second Git status and comparison budget starts. A read, including
time waiting for a slot, has a four-second ceiling. Cleanup runs in the
background within the same concurrency limit. Startup removes private
snapshot directories older than 24 hours. Snapshots use the data directory
when it is outside the worktree and writable, and the system temporary
directory otherwise.

Copied ignore files, including `core.excludesFile`, must resolve inside
the checkout or its Git directories. The 1 MiB limit applies to each copied pattern file.
Unreadable ignore files are skipped, and `info/exclude` retains its usual
precedence. Git reads worktree `.gitignore` files directly. Git versions
with `GIT_ATTR_SOURCE` support read attributes from the empty tree, so files
that depend on attributes for content conversion may count as changed.

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
seconds while clients are connected and publishes changed overviews independently
of ship details. Overview reads have a 25-second deadline. Host and gateway
enrichment and individual ship details each have a 20-second deadline.
When an overview read fails or times out, the poller can republish the last
successful overview with `overviewStale: true` and its original `generatedAt`.
That fallback expires 75 seconds after the successful read and is discarded
when the configured ship roster or a ship's backend identity changes. On
expiry, the server closes the streams so clients can reconnect for a fresh
snapshot. Host and heartbeat events continue while the poller waits for a
fresh overview, including after a backend change.
At three times a read's deadline, another attempt can start. Each overview,
enrichment, host metrics, crew sample, and ship detail slot allows one
outstanding abandoned read alongside the current attempt. If the first
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
refresh, a caller can use a recent sample after one second. A successful
sample up to 23 seconds old at the start of a refresh remains usable until
the shared read completes. A disconnected caller cancels its own wait.
Fleet API shutdown cancels shared crew reads. A committed configuration
reload invalidates cached crew samples and cancels reads for retired backends.
Unchanged backends keep their in-flight reads, including reads shared with
HTTP requests.
After a shared read fails or reaches its deadline, the overview marks the
ship unavailable and retains its last successful crew counts if available.
OpenCode `fleetStatus` probes start with a 400 ms budget that doubles after
a timeout, up to 6.4 seconds, leaving time for ordinary crew status.
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
