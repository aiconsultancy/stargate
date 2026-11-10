# Maintenance policy

- Reuse an existing updater and its lock; never schedule competing writers.
- Never collect credentials in job files, commands, logs or reports.
- An installed binary, an active service and its package owner can differ.
  Inspect all three before choosing an update command.
- A live process surviving replacement of its executable does not prove
  that lazy dependency loads or pending tools remain safe.
- Shared agent CLIs: use their existing package manager, prefix and private
  logs. Require a verified idle window before replacing shared dependencies.
- CLIProxyAPI: stage a verified release with the old binary retained.
  Activation needs a separately approved, idle maintenance window.
- Pogo dependencies: use a feature branch, preserve aligned Pi versions and
  the SDK-aligned Effect pin, update manifests and lockfile together, run
  `make check`, then request review and a separate deployment decision.
  Never mutate a managed release's live `node_modules`.
- AgentsView: preserve its private archive, importer scope, wrapper, local
  model configuration and release-checksum verification.
- Worktrunk: if the executable or owner is unknown, report the gap. Do not
  install a second copy as an update workaround.
- A schedule authorizes execution only within the existing tool and
  operator permissions. It does not grant restart, destructive recovery,
  credential changes, global configuration changes or provider changes.
