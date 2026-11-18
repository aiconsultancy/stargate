# Changelog

## Unreleased

### Feature flags

- New flags: none.
- Default changes: none.
- Enabled by default: none.

### Changes

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
