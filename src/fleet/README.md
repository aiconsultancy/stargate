# Deprecated Fleet package path

`src/fleet/` is a temporary migration shim. It will be deleted once existing
OpenCode configurations move to the new path. It loads the same plugin as the
[canonical Fleet package](../../plugins/opencode/fleet/).

Do not use `src/fleet/` for new installs. Migrate existing installs to
`plugins/opencode/fleet/`: replace only the `package` path and keep the same
`options`.
Do not configure both paths. See [Fleet tools setup](../../docs/fleet-tools.md).
