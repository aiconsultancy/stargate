# Fleet API v1 events

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
An event stream request holds a read slot only while it is checked, and
moves to a stream place once it opens.
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
Ordinary OpenCode `fleetStatus` probes, which ask for no task text, start
with a 400 ms budget that doubles after a timeout, up to 6.4 seconds, leaving
time for ordinary crew status. Timeouts count toward the pause below at the
maximum budget. Task text reads have no probe budget, and their timeouts
never double it: they wait for the caller's crew deadline. Ordinary and task
text probes run separately, each with its own drain bound and pause, and
neither waits behind the other. Concurrent callers with the same filter share
one probe. Three consecutive failures of one kind pause that kind of probe
for one minute; an explicit missing-method response to the initial request
pauses both.
A failed re-ask counts as one task text failure, and so does a task text probe
ended by its last caller's crew deadline, in either request. A disconnect
counts nothing, even if the plugin ignores the abort and Stargate later
abandons the probe. A caller leaving while another waits does not end the
probe. A re-ask answered after the deadline caches nothing. A member ID the
crew plugin would reject is never sent to it: the crew member route answers
`404` when admitted, or `503` when every HTTP read slot is busy.

Activity includes newly observed task outcomes, even if the task also
started between polls. Discovering an existing PR after startup or Git
recovery does not generate activity.

A frame contains an `event:` line, one `data:` line with JSON, and a blank line.

```text
event: heartbeat
data: {"at":1730000000000}

```

Up to eight clients can stream at once, with or without
[`agent-activity`](api.md#live-activity-events) subscriptions. Further connections
receive 503, and streams that fall behind are closed; a closed stream's
place is free at once, even if its reader stopped reading. Reconnect for a
new snapshot. There is no event replay.
