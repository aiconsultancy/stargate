# Changelog

## Unreleased

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
