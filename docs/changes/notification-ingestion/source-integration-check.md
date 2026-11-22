# NET-1733 current-source integration check

Static assessment for the delivery-plan author. No plan approval or build.
The approved core contracts fit current main. The host, authorization and
shutdown integration need explicit adaptation before implementation.

## Evidence and scope

Every repository reference below means the immutable object
`71fc14dc070bc88135e104c3e16742e8a92c28cf:<path>:<lines>`, read with
`git show OID:path` in the repository.
Line numbers are source-file lines, not working-tree locations.

R7 means the 840-line file
the corrected R7 source identified in `inputs.md`.
Its SHA-256 was checked against inputs.md:
`ab6025b4656308da672eb50ba8bdedced4a981dc4b1ae8f3a9c5c9da33889d50`.
The owner approval supersedes its historical draft header. Bounded replay
and same-instant signature merging are selected policies, not open questions.

Repository choices: strict TypeScript, Bun SQLite, bun:test, Effect 4.1.0,
OpenCode SDK 2.3.2 and Promise adapters. See `AGENTS.md:53-107`,
`docs/development.md:15-50,127-135`, `package.json:18-44`,
`bun.lock:227,313,479`, `tsconfig.json:7-23`, `biome.json:19-35`.
PR #77 / b19 was not treated as merged or inspected as current main.

## 1. Reuse the API owner; do not implement the old empty-host slice

Current main already has a private Fleet HTTP listener:

- `src/config.ts:1152-1155` owns top-level `api`.
- `src/dashboard/api/v1/config.ts:5-30` requires `listen`; it has no `enabled` or
  Unix-socket setting. Omission disables the API. Existing configurations
  must not require a new `enabled: true` to keep working.
- `src/dashboard/api/v1/server.ts:78-128,130-217` owns the Bun listener, Fleet source,
  host sampler and event streams. `src/dashboard/api/v1/host.ts` is host metrics,
  not an unused HTTP-host filename.
- `src/app/runtime.ts:982-1011` acquires this server once, before worker startup.
  A bind failure fails startup. The same runtime separately owns dashboard
  and Teams listeners at `src/app/runtime.ts:944-981`.

R7's `api.enabled`, default `api.sock`, no-TCP and no-`/api/...` assumptions
at R7:110-144 conflict with this source. Its slice 1a at R7:769 cannot be
copied literally. Extend the existing API ownership and configuration;
keep one selected API endpoint and static built-in route composition.
Do not add a second `api` schema, token owner, listener or new framework.

The existing Fleet paths are exactly:

- `GET/HEAD /api/v1/fleet`
- `GET/HEAD /api/v1/ships/{id}`
- `GET/HEAD /api/v1/ships/{id}/crew/{member}`
- `GET/HEAD /api/v1/events`

Source: `src/dashboard/api/v1/server.ts:168-209`. Preserve those paths and their
encoded-ID handling. Register notification POST mounts separately under
`/v1/notifications/<mount>`, R7:135-142,511-512. Reserve `/api/v1/...`
for Fleet and `/api/messages` for Teams. Do not reinterpret Fleet paths
through new notification mount normalization. Do normalize and validate
notification mounts once, reject aliases and duplicate method/path claims,
and return fixed 404 for disabled notification mounts.

Existing Fleet TCP binds accept literal private addresses only; they do
not accept wildcard/public binds. CIDR checks use the actual peer, not
forwarded headers. Preserve `src/dashboard/api/v1/network.ts:3-11,58-99` and
`src/dashboard/api/v1/server.ts:140-141`.

The plan must state how Unix-only notification admission and legacy Fleet
TCP configuration coexist. A conservative implementation can add an
exclusive Unix transport to the same host, leave legacy TCP behavior
unchanged and reject notification enablement on TCP for this POC. This
does not preserve simultaneous TCP Fleet access after an operator elects
to switch that instance to Unix; document that constraint rather than
silently opening a second endpoint. Mounting producer POST routes on an
existing private TCP/proxy endpoint needs an explicit scope disposition;
existing Fleet exposure alone is not producer-route approval.

## 2. Split producer authority before the Fleet middleware

The current server applies peer checks, Fleet CORS/preflight, a GET/HEAD
method gate and one Fleet bearer check before route selection.
See `src/dashboard/api/v1/server.ts:33-59,136-168`.
Adding POST to that global method list is insufficient and risks sharing
operator authority with producers.

Reuse the listener, but dispatch to separate trusted route policies before
Fleet-specific CORS, methods and authentication. Keep the Fleet token
operator-only. Producer credentials resolve to a stable configured source
and its topic grants; neither body fields nor the operator token select a
producer identity. Do not implement an "operator OR producer" authenticator.
Reject ambiguous producer credentials and cross-role credential reuse,
including different environment names resolving to the same secret.

`src/dashboard/api/v1/token.ts:10-35,39-85` already owns private token creation and
rotation. `src/app/cli.ts:501-509` exposes the existing operator token command.
Reuse this owner; do not make a second Fleet API token. Producer credential
references belong to the new adapter configuration. Integrate presence
checks with `src/app/setup.ts:120-166` and `src/app/config-reload.ts:20-37`, without
provider calls or logging resolved values. New notification/config input
must reject unknown fields. The existing strict helper is
`src/settings-schema.ts:12-35`; the API schema currently uses a Zod wrapper,
so account for the separately pending migration rather than assuming it.

Fleet CORS defaults are deliberately enabled for Subspace origins:
`src/dashboard/api/v1/network.ts:102-127`, `src/dashboard/api/v1/server.ts:142-155`.
Preserve those responses for Fleet, including token-free GET preflight.
Notification routes must not inherit them. Recommend rejecting browser
`Origin` on notification POSTs, with bearer-only machine requests and no
cookies/CORS. No new operator write, config or health routes are needed.

Existing HTTP limits are not the R7 host contract. `idleTimeout: 30`, a
20-second read signal and eight event streams do not implement bounded
producer bodies, absolute pre-body lifetimes or reserved route capacity.
See `src/dashboard/api/v1/server.ts:130-183` and `src/dashboard/api/v1/events.ts:26-29,144-183`.
The host adaptation needs streamed byte counting, per-route/source limits,
bounded rejected-request disposal, header/connection limits and a global
budget that leaves operator capacity available. Keep timed-out work in its
slot until settlement. Preserve Fleet SSE lifetime and its own cap; do not
apply a 20-second notification deadline to the existing event stream.

## 3. Socket protection exists, but neither helper is a drop-in

For a Unix transport, keep the private directory and mode 0600 contract.
`src/dashboard/dashboard.ts:354-382` uses the instance lock, checks the old path is a
socket, unlinks it, binds through Bun and chmods to 0600. Its comment relies
on exclusive directory ownership and Bun's path removal on stop; this is
not an identity-checked cleanup implementation.

The stronger reusable checks are in `src/lib/unix-socket.ts`:

- `127-185`: normalized path and directory/ancestor ownership checks.
- `234-262`: refuse symlink, non-socket, foreign/live or replaced socket.
- `42-56`: identity includes device, inode and change time.
- `372-459`: locked startup and checked binding.

However, this helper fixes mode 0660 at `24-25` and enforces that exact mode
at `451-457`. Passing a different umask alone fails. If used, make the
smallest private-mode adaptation while preserving Teams' 0660 default and
dashboard group behavior. Keep the gateway instance lock as store owner;
a socket startup lock is not a replacement. Preserve identity-based cleanup
for the new socket and never unlink an arbitrary occupied path.

## 4. Store and runtime lifetimes must join the existing scope

`src/app/runtime.ts:91-99,238-260` takes `instance.sqlite`'s exclusive lock
before opening stores. Add private `notify.sqlite` inside this ownership,
never a second instance lock or entries in `jobs`. `src/cron/store.ts:165-183`
provides the better privacy pattern: no-follow regular-file open, mode 0600
before WAL/SHM, WAL, busy timeout and foreign keys. The older primary store
opens SQLite directly at `src/gateway/store.ts:307-315`; do not copy that as the
whole new-file privacy contract. `start()` sets umask 0077 at
`src/app/runtime.ts:1365-1366`, but programmatic `serve()` callers need safe
store construction too.

R7:182-206,217-276,701-726 supplies the new store rules. Keep them local:
version refusal without reset; duplicate lookup before capacity; one
transaction covering pending-only eviction, fanout and dedup; no leased-row
eviction; immutable physical bindings; attempts and admission age survive
restart. Existing agent retry/receipt policies are different and must not
be reused as the notification state machine. Operational counters are
in-memory in R7:728-729; persistent retry counters are row attempts.

Runtime shutdown currently closes all Slack intake, interrupts the worker
FiberMap, then releases the API host, backends, stores and instance lock.
Relevant ordering is `src/app/runtime.ts:298-318,982-1024,1196-1205`.
An API finalizer at its existing acquisition point therefore runs after
workers stop. A new producer route must close admission at the first intake
gate, before notification worker interruption, rather than relying only on
the existing late API finalizer. Otherwise requests can reach a stopped
admission worker. Resolve every queued publish waiter, keep committed data,
stop claims, abort/drain sends, then close the notification store.

`src/lib/effect.ts:3-47` is the correct Promise settlement bridge. It waits for
the Promise after abort. It cannot bound a sink that never settles.
The plan needs a concrete bounded process-exit path for that R7:274-276
case. Merely timing out a finalizer and closing SQLite is unsafe; an old
attempt could still write or be replayed in the same live process. Keep
the lock/store owned until local users settle or the process terminates.

Maintenance drain holds new agent turns while existing reply deliveries
can finish: `src/gateway/gateway.ts:1102-1120`; steering separately checks the hold
at `599-616`. The drain controller's API is
`src/maintenance/maintenance-drain.ts:423-436,493-518`. Do not add notification work to
agent admission, change the drain marker, readiness criteria or steering.
The notification runtime must have its own producer shutdown gate.

## 5. Reuse the Slack registration, add a request-scoped send

The runtime already resolves Slack team/user identities and rejects duplicate
registrations at `src/app/runtime.ts:435-454`. Reuse those identities and each
registration's existing `SlackConnection`. Freeze bot ID, configured app ID,
authenticated workspace/user, channel and audiences. Do not use `botKey`
for this binding: `src/gateway/routing.ts:43-58` also hashes backend settings, which
R7 explicitly excludes from notification identity.

`announce()` only checks abort before a shared-client send:
`src/slack/slack.ts:182-224`. It does not satisfy the sink contract. The existing
request-scoped `historyWeb(signal)` at `114-127` combines request abort with
the SDK fetch signal while retaining timeout 15 seconds, zero retries and
rate-limit rejection at `107-112`. `activity()` already uses that pattern
at `269-277`. Add a small notification-safe send through the same factory;
do not create another Socket Mode connection or change ordinary reply sends.
Preserve test injection through constructor `webOptions` at `84-90`.

Use `slackContent(text, "plain")`, not `prepareReply`, for literal output.
Its escaped fallback and `plain_text` block are at
`src/shared/slack-format.ts:346-369`. Keep `mrkdwn: false`, `parse: "none"` and
unfurls disabled, as at `src/slack/slack.ts:191-203`. One concatenated title/body/
URL can exceed a section's text limit; the projection must bound each
literal block while keeping one logical send attempt and the stored
signature unchanged. Do not infer transport safety from plain formatting
alone. Only a confirmed Slack success completes a row; ambiguous failure
or abort after dispatch is unknown, not proof of non-send.

## 6. Echo exclusion needs identities and current access, not bot rejection

`src/gateway/routing.ts:102-118` admits verified peer captains when enabled and both
user/channel rules pass. It rejects the receiver's own bot. Peer directory
verification uses live same-workspace bot identity and captain-name checks
at `src/gateway/peers.ts:75-115`. Plain text can still contain a configured captain
name, which routing recognizes at `src/gateway/routing.ts:128-155`. Therefore
ordinary bot rejection, escaped mentions, mention-only access or current
mute state cannot prove notification output is inert.

Check each destination against every local Slack receiver in the same
workspace. Use sender user identity, receiver user/channel allow and deny
rules, peer admission and the self-sender exception. Keep ordinary peer
chat unchanged. Use the same fail-closed predicate immediately before send.

There is a concrete offline-information gap: config has app ID and token
references, but not authenticated team/user or captain-name proof
(`src/config.ts:375-405`). `checkCredentials` checks local references only
(`src/app/setup.ts:120-166`); actual identity arrives at runtime
(`src/slack/slack.ts:148-153`). The plan must specify how offline `config check`
rejects potential conflicts. A conservative rejection when another
peer-enabled registration can share the destination channel avoids adding
network calls or new identity configuration. Startup can additionally use
resolved identities. Unknown peer qualification must not become permission.

Live access reload remains allowed at `src/app/config-reload.ts:89-118` and
updates current bot references at `src/app/runtime.ts:687-695`. A sink that
captures startup access will miss new denies or echo conflicts. Read the
current registration set synchronously at send admission. Notify topology,
sources and limits remain restart-only under the existing top-level diff
rule at `src/app/config-reload.ts:98-103`; do not widen that reload allowlist.

## Verification seams for the author

These are source-backed test entry points, not evidence of tests run here.

- HTTP: `tests/api-v1-server.test.ts:89-131` injects source/diff into a local
  server. Preserve peer/CORS/auth/routes/disconnect/SSE cases at
  `133-341,377-560`; add mixed producer/operator credential and capacity
  tests. Raw local sockets are needed to prove slow headers/body disposal,
  not only synthetic `Request` objects.
- Config: `tests/api-v1-config.test.ts:19-135,193-219` covers private binds,
  strict fields, restart-only settings and token CLI. Add legacy config
  compatibility, disabled notify, invalid mount and credential checks.
- Store: `tests/storage.test.ts:9-45` demonstrates real SQLite reopen and
  exclusive locking. New notify tests must cover rollback after eviction/
  partial fanout, full-store duplicates, stale leases and schema refusal.
- Slack: `tests/slack.test.ts:8-64` uses a local API endpoint through
  `slackApiUrl`. Inject fetch to prove underlying abort/settlement and no
  cross-request cancellation. Use explicit fixtures for rate-limit and
  ambiguous outcomes, plus full-size literal payloads.
- Runtime: `tests/runtime.test.ts:155-220,333-375,583-675,714-779` has fake
  connections/backends and shutdown/startup/Fleet coverage. Add a blocked
  send, queued publish shutdown and early host-admission closure. Retain
  `tests/effect.test.ts:5-27` settlement semantics and the maintenance-drain
  and live-reload suites.
- Echo: extend `tests/peers.test.ts:184-273` with multi-registration notify
  conflicts and access reload. Assert no Gateway/backend calls from accepted
  notifications and preserve ordinary peer admission.
- Version: preserve `src/dashboard/api/v1/gateway.ts:30-42` installed-release, checkout
  tag, package fallback; retain `tests/api-v1-gateway-version.test.ts`.
  Preserve feature reporting at `src/dashboard/api/v1/features.ts:41-52` if adding an
  explicit enable flag. Do not bump dependencies or release versions.

## Minimum decisions for the completed plan

1. Specify the compatible single-host config/transport selection and exact
   notification mount behavior beside legacy Fleet TCP. No implicit new
   network exposure, replacement of Fleet paths or second API listener.
2. Specify the offline fail-closed echo check given missing authenticated
   identities, then startup and send-time checks using current access.
3. Name the shutdown owner and hard-stop mechanism for a non-settling sink;
   an abort signal or elapsed timeout is not sufficient settlement evidence.

These are implementation integration choices. The approved delivery policies
do not need another owner decision. A plan that expands listener exposure
or changes existing Fleet access would exceed this assessment's authority.

Static evidence supports proceeding to delivery-plan composition with these
constraints. This note does not approve an unseen plan. Before code starts,
revalidate actual main and disposition overlapping PR #77 changes.
No runtime imports, tests, probes, provider calls, services or network requests
were executed. No secret configuration was read. Only this note was written.
Poller and IRC remain NET-1734/NET-1735; their extension points are the shared
publish contract and sink interface, with no first-slice implementation.
