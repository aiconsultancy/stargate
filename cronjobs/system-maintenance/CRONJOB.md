---
name: system-maintenance
description: Check agent tool updates; preserve active work and stage unsafe changes.
schedule: "15 3 * * *"
timezone: UTC
skills:
  - stargate-cronjobs
enabled: false
report: daily
---

Read `maintenance-policy.md` before work. This is a disabled example. The
03:15 UTC time matches the existing operator updater, not a newly approved
maintenance window. Confirm timing before enabling this definition.

Check OpenCode, Claude Code, Codex, Pi, CLIProxyAPI, Stargate dependencies,
AgentsView and Worktrunk. Identify each installed executable and its owner.
Use mise where mise owns that installation; do not replace another owner's
installation or assume that installing a pinned version updates the pin.

Check the existing OS updater and its private logs first. Do not run the
same update twice or create a competing schedule. If an existing updater
already completed, verify and report its result instead.

Before changing shared tools, prove that affected agents and requests are
idle. Preserve sessions, queues, history, worktrees and credentials. If
idleness or authorization is uncertain, defer that change and state why.

Apply only authorized updates that do not interrupt work. Stage dependency
and pinned-version changes for review. Do not deploy Stargate or restart the
proxy, OpenCode, AgentsView, model services or this gateway from this job.
Verify versions after an update; do not infer success from installer exit
status alone. Stop the affected update on failure; preserve the prior
installation and state for operator recovery.

Return one concise public result: tools checked, verified version changes,
checks passed, failures, deferred actions and safe local log locations.
Do not post to Slack directly. Stargate stores the final public answer locally
and includes its bounded summary in the configured daily report.
