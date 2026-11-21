---

name: stargate-cronjobs
description: Manage Stargate scheduled and quota-event jobs when a user asks to create, list, run or remove a job, choose a job model or arbiter, or change immediate versus daily reporting. Use the captain-only stargate_cron tool, not OS cron or replacement services.
---

# Stargate cronjobs

Load this skill before managing scheduled jobs. Use `stargate_cron` only from the
configured captain. The host binds the tool to one bot and configuration;
never supply another configuration path, directory, or bot identity.
If the tool reports unavailable, explain the missing operator configuration.
Do not change global configuration or install another scheduler.

## Map requests to operations

- “Create a job” → `op=add`. First use `op=list` to avoid duplicates.
- “What jobs are scheduled?” → `op=list`.
- “Run XYZ now” → `op=run` for the exact listed job name.
- “Remove XYZ” → `op=remove` with the exact job ID returned by list.
- “Show job status” → `op=report` to read retained execution metadata.
- “Report immediately/daily” when creating → set add's `report` mode.

`op=report` does not change settings. Do not claim an existing report mode
changed unless the definition was changed through a supported operation.
List accepts a page; follow pages when the returned job list is full.
List and remove cover every destination for the bound bot, including DMs.
Optional channel/user filters are exact; inspect the returned list filter.
Add and run still default to the configured destination. A five-field calendar
date repeats each year: use `once=true` when only its first success should run.

Use the declared tool fields; do not invent fields or bypass validation with
shell commands. Retain an explicit run requestId when retrying the same request;
otherwise the host supplies its tool-call identity. An intentional new run is
a new request, not a retry of an uncertain run. Inspect retained status first.

## Define jobs

Keep the single job prompt in `cronjobs/<name>/CRONJOB.md` under the configured
captain workspace. Frontmatter describes name, description, five-field schedule,
explicit timezone, skills, enabled state, report mode and Slack destination.
Use a stable lowercase job name. Confirm the intended Slack channel and user;
never infer a destination from an unrelated conversation.

Confirm schedule and timezone before enabling execution. If the time is not
decided, create with `enabled=false` and a valid provisional schedule, clearly
marked as provisional. Ask for the missing timing decision; do not silently
enable it. Do not use a six-field seconds expression.

With operator-enabled `cronjobs.advanced`, use `trigger` for a quota event:
`{"type":"quota-reset","provider":"codex"}` or
`{"type":"quota-threshold","provider":"codex","usedPercent":98}`.
Omit `schedule` for an event-only job; keep both for either event or clock.
Use optional `window` and `scope` to narrow the provider window. The gateway
checks quota without a model turn. Reset requires `resetAt` to move forward by
at least one hour and either usage to drop by at least five percentage points
or the previous reset time to have passed. Other timestamp drift updates the
observation silently. A threshold fires once per qualified reset cycle.

Set `model` to a verified `provider/model#variant`, `once=true` to remove the
job after its first success, and `arbiter=twiki` for a configured Pi decision
member. Model and arbiter evaluations are tools-off and do not change or
occupy the captain's or crew member's durable session. Only `act` or
`escalate` forwards the result for action; `ignore` stays private. Never use
an arbiter verdict to bypass approval, credentials or an owner decision.
An interrupted evaluation is held, not replayed.

Verify creation with `op=list` and `op=report`: check the exact job's trigger,
model, once flag and arbiter. A missing flag, unavailable model or scope-drift
error is a configuration gap, not permission to use a different provider or
delete state. Ask the operator to reconcile the gateway and tool configuration.

Reference reusable skills in `skills`; require the executing agent to load
every listed skill before work. Do not copy their prompts into the job body.
Keep job-specific supporting files beside CRONJOB.md and reference them by
relative path. Keep secrets outside job files and tool arguments.

## Execute and report safely

Preserve active and queued work. A busy or deferred run is not completion;
do not interrupt a worker, reset a session, or submit duplicate work to force it.
Report only the returned admission/status evidence. Never claim a job finished
because its schedule was saved or its run was accepted.

`report=immediate` uses the job's Slack destination. `report=daily`
silently records results locally and includes them in one daily digest
(08:30 UTC by default),
not a Slack message for each run. Deferred report results remain local until
their configured report. Do not send a separate message to bypass that policy.

Check for an existing OS updater before creating update jobs; do not duplicate
it. Never schedule blind self-restarts or live dependency updates. Maintenance
must keep existing approval, cancellation and rollback requirements. A schedule
does not grant permission for destructive changes or broader tool access.
