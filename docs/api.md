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

Checkout Git status counts changed gitlinks and skips worktree dirt inside
submodules. Status reads run in a private Git directory with a copy of the
index, a pinned HEAD, and access to the checkout's objects. The snapshot
includes repository-configured `core.excludesFile` patterns and preserves
the precedence of `info/exclude`. Pattern files have a 1 MiB limit, each
index file has a 128 MiB limit, and the snapshot has a 192 MiB aggregate
limit. Oversized metadata produces a Git read error. Git versions with
`GIT_ATTR_SOURCE` support read attributes from the empty tree, so files
that depend on attributes for content conversion may count as changed.

Pull requests are looked up by head owner and branch, including branches
with numeric names. The head repository's owner and name must match the
branch's GitHub push repository, reported as `git.pushRepository` when
resolvable. Stargate fetches check results for the matching PR. The
lookup targets the GitHub repository at `origin`, or the push repository
when `origin` has no GitHub URL. A failed or incomplete refresh retains the
last successful result. For a crew context, `pullRequestKnown: true` means its
branch has a settled lookup. With that field present, `pullRequest: null`
means no matching PR was found.

## Events

Use a streaming browser `fetch` with an `Authorization` header. A connection
gets a `fleet` event with host and gateway information, followed by the
initial `ship` details. One shared poller reads the overview every three
seconds while clients are connected and publishes changed overviews independently
of ship details. Overview and ship reads have 20-second deadlines and
keep their slots until they settle. Changed details emit a full `ship`
event with `detailUpdatedAt`. Timestamp-only refreshes emit
`ship-sampled` with `id` and `detailUpdatedAt`. Clients can use this event
to update the timestamp on the cached detail. If a refresh fails,
`detailStale` is set to `true` on the last successful detail, which keeps
its original sample time. A crew failure before the first successful
detail emits an unavailable `ship` with an `error` field. A successful
refresh clears `detailStale`. Availability activity follows the overview's
availability transitions. The stream also sends `host` every ten seconds
and `heartbeat` every fifteen seconds.

The overview and ship details share one crew read per ship. Each caller waits
up to one second, and a disconnected caller cancels its own wait. The shared
read can take up to 20 seconds. If a caller's wait expires during a refresh,
it can use a successful sample from the previous five seconds. After a
failure or when no fresh sample is available, the overview marks the ship
unavailable and retains its last successful crew counts if available.
OpenCode `fleetStatus` probes have a 400 ms budget so ordinary crew status
can run on probe failure. An explicit missing-method response or three
consecutive failures, including probe timeouts, pause probes for one minute.

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
