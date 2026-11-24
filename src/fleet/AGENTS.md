# Fleet shim: scheduled for removal after migration

- This directory is temporary. Do not add callers, tools, options, behavior,
  or dependencies here. Point new callers to the canonical package.
- Change the plugin in [its canonical directory](../../plugins/opencode/fleet/).
- Delete this directory and the old-path loader test in a focused change once
  existing installations no longer reference `src/fleet/`. Do not promote the
  shim to a supported package.
- Run `bun test tests/fleet-tools.test.ts` from the repository root after changing
  either package entry point. The tests load both paths with the OpenCode V2 loader.
