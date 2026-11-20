# Changelog

## Unreleased

### Feature flags

- New flag: `bots[].slack.inboundReactions`, default **off**. Deliver listed
  reactions and their removal on this bot's Slack messages to its session.
- New opt-ins: IRC `questionOperator` enables private handling of background questions on a pinned captain with `features.questions`. IRC `features.liveProgress` enables event-based request notices and status. Both default off.

- New opt-in: `api.listen: "unix"` selects a private mode-0600 Fleet socket
  instead of TCP. Omitted `api` still defaults to off. No `enabled` alias.
- Default changes: none.
- Enabled by default: none.
- New opt-ins: IRC `features.crewQuestionHandoff` and crew `team.questionGateway` route native crew clarifications through the owning gateway. Both default off.

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
