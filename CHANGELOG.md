# Changelog

## Unreleased

- Add `maintenance.models.updateGlobalCatalog` (default **off**). When enabled,
  nightly maintenance adds probed new proxy family members to the global
  OpenCode catalogue before upgrading profiles and sessions. Settings and
  variants come from the newest declared family member. No flags are enabled
  by default in this change. See [model upgrades](docs/maintenance.md#model-upgrades).
- Add Astra to the default model families. Report `-fast` and `-ultrafast`
  products without automatically selecting them.
