# Changelog

## Unreleased

### Feature flags

- New flags: `usageGuard.enabled`, default off.
- Default changes: the `stargate.crew` plugin's `feedbackEnabled` option changes
  from off to on for pinned teams. Submit and captain review still require
  separate native permissions.
- Enabled by default: `feedbackEnabled` for pinned teams. Set it to `false`
  in the plugin options to disable the private feedback inbox tools.

- Crew names and officers' Fleet API sockets add no flags and change no
  defaults. Officer sockets require `subspaceAgents`, which remains off by
  default.

- No new flag: the Fleet API route `/api/v1/agents/{id}/activity` is on
  whenever `api` is configured, by the owner's decision. It serves OpenCode
  officers' recent turns, including tool input and output, errors, reply and
  reasoning text, unredacted and untruncated. The gateway feature
  `api.agentActivity` reports it.

- No new flag: `/api/v1/agents/{id}/activity?request=<msgid>`, optionally
  with `&channel=<channel>`, returns an officer's retained turns that answer
  an IRC message. Every turn, in snapshots and `agent-activity` events, lists
  its IRC `requests`. The jobs and IRC burst tables each gain one nullable
  column; requests queued before the upgrade are not backfilled.
  `api.agentActivity` covers both.

- No new flag: `/api/v1/events?agent=<id>` streams an officer's turn changes
  as `agent-activity` events on the same terms, within the existing eight
  streams and 256 KiB per viewer; `api.agentActivity` now covers the event
  too.

### Changes

- Add the usage guard for rear admiral quota notices in each ship channel
  and provider-specific cutoffs on new crew turns.

- Reorganize source code into bounded slices. Chat features live in `src/chat/`,
  and Fleet dispatch lives under `src/coordination/fleet/dispatch/`.
- Move the OpenCode plugin entry points to `plugins/opencode/`. Crew still
  loads from the repository root. For Fleet, use `plugins/opencode/fleet/`.
  Migrate existing `src/fleet/` configurations before the temporary shim is
  removed. Configure only one Fleet package path.

- In IRC, a top-level channel request to a captain starts a thread. Enrolled
  humans can continue the thread without naming the captain again.
- The Fleet API can read Crew Git state through the captain's Crew plugin.
  After you update the plugin, Git state and pull request lookup work even if
  the gateway cannot read the captain's home directory.

- Let a fleet's officers and their crew read the whole fleet's Fleet API,
  read-only and without the fleet token ([docs](docs/api.md#officers)). The
  gateway with `subspaceAgents` enabled serves `GET` and `HEAD` for the four
  Fleet API routes on `fleet-api.sock` in each officer's socket directory (mode
  `0660`, the directory's group), with or without the `api` listener, using
  officers' own read and stream slots. `stargate fleet request [--socket
  PATH] /api/v1/...` reads it. A `socketPath` named `fleet-api.sock` is
  refused, and start-up stops, naming both, if another configured socket is
  at that path. Fleet Control's `fleet.sock` may share the directory.

- Let a crew member's `name` differ from its ID in the crew plugin's team
  ([docs](docs/agents/default-opencode.md)), so a fleet can name `claude-1`
  Kestrel. The ID still keys the member's state, tasks, sessions, worktree and
  branch, so renaming keeps them. Crew names must be unique in the team,
  ignoring case, and differ from the captain's name, other members' IDs,
  `captain` and `all`. A captain's name must still match its ID.

## 0.45.0

### Feature flags

- New flag: OpenCode `stargate.crew` plugin option `feedbackEnabled` defaults
  off. It enables the private ship feedback inbox for pinned teams. Submit
  and captain review require separate native permissions.

- New flag: `subspaceAgents.enabled`; the whole `subspaceAgents` section is
  absent by default, and absent or off loads nothing, creates no file or
  socket and makes no request. When on, the gateway holds one key and
  certificate per officer, enrols it with the Subspace API and signs each
  officer's API requests on that officer's Unix socket.
- New flag: `agentDispatch.enabled` defaults off. When on, the rear admiral's
  IRC gateway polls the Subspace API, tells a captain about an issue assigned
  to it and offers issues flagged _Ready for agents_ to the fleet's captains
  in turn. Off starts no dispatcher, opens no ledger and makes no API request.
- New flag: `bots[].cronjobs.advanced` defaults off. It enables quota-event
  triggers, per-job model evaluation, one-off jobs and optional crew arbitration.
  Existing clock schedules retain their current behaviour when it is off.
  Cron list and remove now cover every destination for the bound bot, including
  DMs, unless explicit destination filters are supplied. Configuration drift
  returns an error instead of a misleading empty inventory.
- New flags: Teams `livePresence` defaults off. IRC `features.fleetTyping`
  defaults on. Fleet `api.pullRequestRepositories` enables pull request lookup
  only for bound checkouts and defaults to no bindings.
  HTTP notification inputs `notify.adapters.<name>.enabled` default off
  and require Unix API mode when enabled.
- Default changes: IRC `features.liveProgress` defaults on.
  `features.questions` defaults on for OpenCode registrations with enrolled
  humans. `features.crewQuestionHandoff` defaults on for pinned OpenCode IRC
  registrations. An unspecified crew plugin `team.questionGateway` uses
  handoff while the owning gateway is polling. Paired crew questions default
  on when the captain's per-agent question settings are absent.
  Pinned crews using a writable `team.historyAPI` without a polling IRC gateway
  must set `team.questionGateway: false` to retain direct native questions.
  When enabled questions lack the required gateway, Stargate logs the wait
  once per plugin location.
- Enabled by default: IRC live progress, fleet typing, native questions for
  supported registrations, and paired crew question handoff. Background
  question alerts still require a configured `questionOperator`.
- Teams waiting phrases: none. They use the existing Teams `livePresence`
  flag and `waiting` settings; no flag is added and no default changes.

### Changes

- Add optional Subspace API agent identity
  ([docs](docs/subspace-agents.md)). `stargate subspace enrol` gives each
  configured officer a private Ed25519 key and self-signed certificate and
  enrols it with a one-time fleet enrolment token; `--rotate` replaces it and
  reports the old fingerprint. Each officer's socket forwards `/api/v1/` and
  `/mcp` requests with a fresh agent token signed by that officer's key.
  `stargate subspace mcp` is a stdio MCP bridge for harnesses and
  `stargate subspace request` a REST call; Claude officers get the bridge
  automatically.
- Add optional agent dispatch for a fleet's rear admiral
  ([docs](docs/agent-dispatch.md)). It polls the Subspace API outbound only
  (default every 120 seconds) with the rear admiral's bearer token from
  `agentDispatch.api.tokenEnv` and optional private-access headers from
  `api.headersEnv`. Captains answer offers with the new `fleet_answer_offer`
  fleet tool, sent as an IRC reply carrying `+stargate/dispatch`, counted only
  from the asked captain's account. Offers time out after 300 seconds; rounds
  repeat after 1, 3, 6 and 12 hours, then the rear admiral comments and clears
  the flag. A durable ledger survives restarts. Only the rear admiral's
  dispatch requests, recognised from the captain's `fleetControl.targets`
  entry with `role: "rear_admiral"`, are never dropped by the IRC peer turn
  limit; they still count towards it.
- Show the shared waiting phrases with the bot's display name in Teams live
  presence instead of the generic “Thinking” and “Working” labels. They follow
  `waiting.delayMs`, `waiting.intervalMs` and a captain's waiting override,
  rotate only on the existing presence refresh, and stop with the turn.
  Specific stage labels are unchanged.
- Add durable quota-reset and quota-threshold cron events without model polling.
  Retain immutable model/arbiter choices, suppress ignored output and remove
  one-off jobs only after a successful run. Refuse configuration/namespace drift
  in cron controls rather than returning an empty list while old jobs run.
- Deliver Claude MCP configuration over stdin after checking the CLI version.
  Known older CLIs use explicit argv delivery with a safe exposure warning;
  unknown versions and failed probes stop the turn before the SDK starts.
- Tag IRC fleet request progress notices with a fixed stage and the triggering
  message ID. Publish terminal stages from confirmed gateway outcomes.
- Reserve addressed IRC `status` in registrations with enrolled humans for
  checking the original request. Disable live progress to use addressed
  `status` as an ordinary message.
- Isolate Fleet API Git status from checkout configuration and bound primary
  and shared indexes before Git loads them. Use copy-on-write index snapshots
  where supported on Linux and give snapshot preparation its own deadline.
  Recheck HEAD after the ahead/behind comparison. Clean up Git snapshots in
  the background and sweep stale directories on startup. Report Git state
  unavailable if the temporary snapshot fallback is inside the checkout.
  Cache a checkout's own timeout for 15 seconds and a timeout spent mostly
  waiting for a read slot for one read deadline (two seconds).
- Look up Fleet pull requests only for checkouts bound to a GitHub repository
  in `api.pullRequestRepositories`. Require the PR head to belong to the
  bound repository. Unbound checkouts leave PR state unknown.
- Keep recent crew samples usable during slow refreshes and wait for the
  shared crew read when no recent sample is available. Adapt the OpenCode
  fleet probe deadline for slower captains and back off after repeated failures.
- Retry stalled Fleet API reads after a hard cap with at most one abandoned
  read per slot. Serve cached metrics when fleet HTTP enrichment times out and
  publish fresh host samples when ready within one second, falling back to
  the latest sample during slower refreshes. Retained ship details
  report captain unavailability immediately and preserve the last successful
  crew data and sample time.
  Availability transitions supersede older detail reads. Recovering ships
  wait for fresh detail when no successful sample is cached. Replacement
  backends get independent detail read slots. Retained overviews are marked
  stale and close event streams on expiry after 75 seconds. Host and heartbeat
  frames continue while a new overview is pending. Configuration reloads
  invalidate cached crew samples and keep in-flight reads for unchanged
  backends, including Fleet HTTP requests. Requests already waiting for crew
  data continue to wait for the shared read after reload clears their fallback.
  Event streams discard in-flight overviews when the roster or a ship's
  backend identity changes.
- Publish lightweight `ship-sampled` events when only the ship detail
  timestamp changes. Preserve the observation time when a crew sample is reused.
- Publish Fleet events when gateway metadata changes, including when the OpenCode
  version first becomes available.
- Add private authenticated HTTP notification ingestion, atomic durable outbox
  admission and literal Slack delivery without agent work. Freeze physical
  destinations and audiences, recheck current access and echo policy, and
  retain store ownership through send settlement or process termination.
  See [notification ingestion](docs/notification-ingestion.md).

## 0.41.0

### Feature flags

- New flags: `bots[].slack.inboundReactions` delivers listed reactions, and
  their removal, on this bot's Slack messages to its session. IRC
  `questionOperator` enables private handling of background questions on a
  pinned captain with `features.questions`. IRC `features.liveProgress`
  enables event-based request notices and status. IRC
  `features.crewQuestionHandoff` and crew `team.questionGateway` route native
  crew clarifications through the owning gateway. `api.listen: "unix"`
  selects a private mode-0600 Fleet socket instead of TCP; omitted `api`
  still defaults to off, with no `enabled` alias. All default off.
- Default changes: none.
- Enabled by default: none.

### Changes

- Route admitted people's thumbs up, thumbs down, tick, cross and eyes
  reactions as conversation input, without interpreting their meaning.
  Slack app owners must grant `reactions:read` and `users:read`, and subscribe to
  `reaction_added` and `reaction_removed` before enabling the flag.
- Serve Fleet through one bounded HTTP host, preserving private TCP access,
  operator authentication, CORS and streamed events. Add the exclusive private
  Unix mode and internal exact-route contract. Notification routes are not yet
  wired. See [Fleet API](docs/api.md).
- Harden Fleet API Git reads against checkout-configured commands.
- Report Fleet API task outcomes that complete between event polls.
- Look up pull requests by head branch, keep cached results on refresh
  failure, and suppress PR activity when the previous lookup was unknown.
- Label the Fleet API's data filesystem `data` in disk metrics.
- Require an explicit Fleet API CORS origin for Windows WebView2 Spaces.
- Reuse crew status across Fleet API event frames and avoid repeated
  unsupported status calls on older OpenCode plugins.
- Keep Fleet API overviews and healthy ship details streaming when another
  ship's detail read fails, and mark retained detail as stale.
- A git checkout of a release now reports its `vX.Y.Z` tag at HEAD as the
  Fleet API's `gateway.version` when it has no `.stargate-release.json`.
  Fetch the tag, not only the commit. Other source checkouts still report the
  package version.
- Report OpenCode turn progress in IRC and flag earlier pending questions
  before submitting a new request.

## 0.40.1

### Feature flags

- New flags: none.
- Default changes: none.
- Enabled by default: none.

### Changes

- The Fleet API's `gateway.version` reports the installed release's version
  from `.stargate-release.json`, not the package version, which stays at
  `0.1.0`. Source checkouts still report the package version.

## 0.40.0

### Feature flags

- New flag: the top-level `api` object enables the Fleet API (default **off**).
- Default changes: none.
- Enabled by default: none.

### Changes

- Add a private-network, read-only Fleet API with bearer authentication,
  host metrics and streamed fleet events for Subspace. See the
  [Fleet API setup guide](docs/api.md).

## 0.39.0

### Feature flags

- New flags: `maintenance.drain.enabled` (default **off**), with
  `maintenance.drain.deadlineMinutes` (default **10**, range 1–1440).
- New flags: `slack.steerThreadFollowUps` and
  `irc[].features.steerThreadFollowUps`, both default **off**. They deliver
  same-thread follow-ups to a running OpenCode turn as steering input.
- Default changes: IRC's peer-turn limit rises from 5 to 30 per receiving
  connection and conversation in a rolling hour.
- Enabled by default: none.

### Changes

- Opt-in maintenance restart drain: queue a passive notice for captains and
  crew, hold new work in existing durable queues, wait for idle or the drain
  deadline, report stragglers, and queue restart completion context before
  resuming. Maintenance reports and `/health` show the drain state. No host
  enables this flag automatically; release approval decides activation.

- Add opt-in same-thread follow-up steering for running OpenCode turns. Other
  threads retain queue isolation and receive a queue notice. Refused steering
  falls back to the existing queue. Stop and local controls stay separate.
  See [follow-up steering](docs/operations.md#follow-up-steering).

- Guide new ships on choosing reviewable pull requests by complexity and
  risk. Existing ships can add the guidance to their working agreement.

- Allow longer IRC peer handoffs by default. Set `access.peerTurnsPerHour`
  to `5` to retain the previous default. Slack keeps its existing default.

- Retry Slack startup DNS/network failures and later disconnects with bounded
  backoff. Require a connected transport before readiness and expose connection
  states in the ready record and `/health`. Exhausted retries fail the service
  so its manager can restart it. No new flag or default change.

- Require manual dispatch and approval through the `release` environment before
  publishing. Merging a green PR no longer publishes a release. Main protection
  requires up-to-date Quality checks; use `gh pr merge --auto --squash`.

## 0.38.0

- Add per-captain OpenCode question controls (default **off**) through
  `/config questions on|off`. Slack uses buttons, checkboxes and custom replies;
  crew questions route to their originating captain. Timeout defaults to 15
  minutes; answer policy defaults to requester only. No flags become on by
  default. See [question controls](docs/meta-commands.md#opencode-clarification-questions).

## 0.37.0

- Add `notifications.updateNotice` (default **off**): passive queued update
  context for captains and OpenCode crew, plain mail for Pi crew, and a
  next-turn notice for unpinned Slack sessions. Notice receipts appear in
  readiness and maintenance reports. No flags are enabled by default.

## 0.36.0

- Add `maintenance.models.updateGlobalCatalog` (default **off**). When enabled,
  nightly maintenance adds probed new proxy family members to the global
  OpenCode catalogue before upgrading profiles and sessions. Settings and
  variants come from the newest declared family member. No flags are enabled
  by default in this change. See [model upgrades](docs/maintenance.md#model-upgrades).
- Add Astra to the default model families. Report `-fast` and `-ultrafast`
  products without automatically selecting them.
