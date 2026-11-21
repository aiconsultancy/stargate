# Recurring prompts

Use `/cron` in an allowed channel or DM to manage recurring prompts.
Each schedule repeatedly sends its prompt to the current bot's backend.
Selecting **Add** authorizes recurring execution, not only prompt storage.
Scheduled work uses the bot's existing tools and access. Results are posted
in a new thread in the channel where you created the schedule.

## Commands

| Command                 | Result                                                |
| ----------------------- | ----------------------------------------------------- |
| `/cron` or `/cron list` | Open your schedules for this bot and channel.         |
| `/cron add`             | Open the Add form.                                    |
| `/cron remove`          | Open your list with Remove buttons.                   |
| `/cron run NAME_OR_ID`  | Admit an owned job now without changing its next run. |

Lists show 10 schedules per page. Use **Next**, **Previous**, or **Refresh**.
The list is private to you; it does not list other users' schedules.
Use **Add** in the list to create a schedule. A successful submission saves
the schedule and closes the modal. Run `/cron` again to inspect it.

The form requires:

- **Name:** a short task label, up to 80 characters.
- **Cron expression:** five fields: minute, hour, day-of-month, month,
  day-of-week. For example, `0 9 * * 1-5` runs at 09:00 on weekdays.
- **IANA timezone:** explicit scheduling timezone, default `UTC`.
  Examples: `Europe/London`, `America/New_York`.
- **Recurring prompt:** the task to run, up to 3000 characters in this form.
- **Result reporting:** immediate (default), or deferred to the daily report.

Use **Remove**, then confirm, to stop future runs. An already queued or
running request may still finish. Removal does not undo tool actions.

## Access and setup

The Slack app must register `/cron`, grant the `commands` bot scope, and
enable interactivity with Socket Mode. Existing installations need the
updated manifest and may need reinstallation. Follow [setup](setup.md).
Changing a local manifest does not update an installed Slack app.

Custom slash commands cannot run inside message threads. Invoke `/cron` from
the channel or DM composer. Slack command names are workspace-wide: if another
app registers `/cron`, Slack routes that name to the most recently installed
app. Do not register the same command on multiple Stargate apps in one workspace.

Each command, button, and form submission checks the configured app and
workspace, current user/channel access, and schedule ownership. Denies
override allows. You can manage only schedules you created for the current
bot/backend identity and channel. Changing backend settings selects another
schedule namespace; old schedules are not executed with the new backend.

## Limits

- Stargate must be running for scheduled work to start.
- Missed intervals are skipped, not replayed as a backlog.
- A schedule does not start overlapping runs while prior work is active.
- Access is checked again before scheduled work and reply delivery.
- Retried form submissions do not create duplicate schedules.
- Interrupted or uncertain Slack announcements are not automatically reposted.
- Missing gateway queue history holds the schedule until you remove it;
  Stargate does not guess whether its tools ran.
- No exactly-once guarantee applies to external tool actions or Slack delivery.
- Prompts are stored in the private SQLite state. Keep backups private.

The UI uses Slack's [modal lifecycle](https://docs.slack.dev/surfaces/modals)
and [confirmation dialogs](https://docs.slack.dev/reference/block-kit/composition-objects/confirmation-dialog-object).

## File-backed jobs

Opt in on one bot in `stargate.json`:

```json
"cronjobs": {
  "directory": "/srv/captain/cronjobs",
  "channel": "C123",
  "user": "U123",
  "dailyReport": {
    "channel": "CREPORT",
    "time": "08:30",
    "timezone": "UTC"
  }
}
```

Use real Slack IDs. Both destinations and the human owner must pass this
bot's access rules. Invite the bot to the channels. Configuring a report
channel authorizes publication of this bot's allowed job summaries there;
do not select a channel with a wider audience than those results permit.
Omit `dailyReport` to disable automatic reports. Its channel defaults to
`cronjobs.channel`; its time defaults to `08:30`. Reports currently use UTC.

The directory is an explicit execution boundary, not a general file search.
Each bot needs its own directory. Stargate checks up to 100 immediate job
directories every ten seconds. Configuring this directory authorizes its
valid, enabled definitions to run; do not point it at unreviewed files.
Without this setting, existing SQLite-only schedules continue unchanged.

```text
cronjobs/
└── overnight-maintenance/
    ├── CRONJOB.md
    └── maintenance-policy.md
```

```markdown
---

name: overnight-maintenance
description: Check maintenance outcomes without interrupting active work.
schedule: "15 3 * * *"
timezone: UTC
skills:

- stargate-cronjobs
  enabled: false
  report: daily
  slack:
  channel: C123
  user: U123

---

Read maintenance-policy.md. Check the existing updater and its logs.
Preserve busy workers; return verified changes, failures and deferred work.
```

The lowercase kebab-case name must match the directory. Frontmatter is
strict; unknown keys fail validation. `timezone`, `skills`, `enabled` and
`report` default to `UTC`, `[]`, `true` and `immediate`. The optional `slack`
object overrides the configured default owner and destination together.
The Markdown task is limited to 12,000 characters; the compiled prompt,
including file and skill references, must also fit 12,000 characters.
Files are limited to 64 KiB. Symlink paths are refused. New files and
directories use private permissions. Supporting files are not copied or
automatically loaded; their paths resolve relative to the job directory.

Skill IDs reference the executing agent's installed skills. The run prompt
requires those skills to be loaded; missing skills must be reported. Skill
loading is an agent instruction, not a new permission grant.

SQLite retains scheduling state and immutable accepted task snapshots.
Definition edits affect future admissions, not accepted work. Supporting
files are read at execution time; their contents are not snapshotted.
Changing only task text does not move the next scheduled time. Invalid or
missing definitions disable new admissions without deleting history.
`enabled: false` pauses recurring work but permits an explicit run-now.
Removal leaves a durable tombstone; rediscovery does not revive it. Use a
new name for a replacement job. Do not delete state to reactivate a job.

When file-backed jobs are configured, `/cron add` creates `CRONJOB.md` with
the invoking user/channel as owner/destination. Use kebab-case names.
Existing different definitions are never overwritten. Edit a reviewed file
to change its task or report policy; there is no tool operation that silently
replaces a definition.

## OpenCode tool and local CLI

Generated profiles expose the `stargate-cronjobs` skill. Bind the captain tool
to one existing gateway configuration and bot. For a new profile, copy
[`team.example.json`](../team.example.json) to `/srv/stargate/team.json`.
Set its Pi helper's model, provider URL and credential environment reference
for this instance. Verify the model route and reference in the OpenCode plugin
host before creating a worker; copying the example does not make it ready.

```sh
stargate crew init --team /srv/stargate/team.json \
  --directory /srv/captain --project /srv/project \
  --worktrees /srv/crew --cron-config /srv/stargate/stargate.json --cron-bot helper
```

For an existing profile, merge this non-secret binding into the existing
Stargate plugin options; preserve other options and the pinned captain session:

```json
"cron": { "configPath": "/srv/stargate/stargate.json", "bot": "helper" }
```

The same binding enables the captain's `stargate_post` tool when the bot sets
`captainPost`; see [captain posts](captain-post.md).

Add the package's `templates/skills` directory to the profile's `skills`
sources if absent. No global configuration change is required. The
captain-only `stargate_cron` tool supports `list`, `add`, `run`, `remove` and
`report`. Its host binding cannot be changed through tool input. Both the
native captain authority and configured backend directory are checked.
Crew and child sessions cannot use it to schedule work as the captain.
Say “create a job” or “run overnight-maintenance”; the captain uses this
tool rather than inventing another scheduler. New runs use a durable
request identity; retries or overlapping work do not create another run.
Admission is not completion. Inspect status before retrying uncertain work.

Local operator equivalents:

```sh
stargate cron list --config /srv/stargate/stargate.json --bot helper
stargate cron add --config /srv/stargate/stargate.json --bot helper --input job.json
stargate cron run overnight-maintenance --config /srv/stargate/stargate.json --bot helper
stargate cron remove JOB_UUID --config /srv/stargate/stargate.json --bot helper
stargate cron report --config /srv/stargate/stargate.json --bot helper
```

`job.json` uses the tool's add fields: `name`, `description`, `schedule`,
`timezone`, `prompt`, `skills`, `enabled`, `report` and optional `channel`
and `user`. Do not put secrets in it. CLI input files are bounded and do
not accept symlinks. These operations use the private cron store and a
Slack authentication check, not a second gateway. The gateway must be
running to execute admitted work. `report` reads execution metadata only;
it does not send a report or change settings.

## Quiet jobs and the bundled daily report

- `report: immediate`: a new Slack thread receives the announcement and
  normal public reply at the job's destination.
- `report: daily`: no announcement, live preview, reaction, activity message,
  failure message, attachment upload or final reply is sent for the run.
  Stargate retains the public result/failure in private local queue state.
- At 08:30 UTC, the configured report channel receives one bounded message
  for this bot: job inventory, deferred outcomes and definition-error count.
  It calls no model. Up to ten jobs and ten result excerpts fit the message;
  each underlying query is bounded to 100 rows. Full public answers remain
  in `<dataDirectory>/stargate.sqlite`; schedules, run status and report claims
  remain in `<dataDirectory>/cron.sqlite`. Keep both private and backed up.
- Reports cover the previous cutoff to today's cutoff, plus older active
  runs and work completed in that window. A run still active at cutoff can
  appear again with its completed outcome in the next report.
- A late startup can send today's report, but missed report days are not
  replayed. A persisted claim precedes Slack delivery; failed or uncertain
  sends are not automatically reposted. Late public text can update local
  results after a report was sent; reports already sent are not rewritten.
- Without `dailyReport`, deferred results remain local. Do not select daily
  reporting unless that silence is intended. Agents must not bypass the
  policy by posting to Slack directly.

There is no system-wide single report across independently configured bots.
Use one captain's job directory/report configuration to bundle its overnight
maintenance tasks.

## Quota events, models and arbitration (opt-in)

`bots[].cronjobs.advanced` is **off by default**. Enable it explicitly on the
intended registration; it does not enable itself on upgrade. Existing clock
jobs keep their behaviour when the flag is absent or false. Advanced definitions
are unavailable while it is off; already accepted advanced work is held without
replay rather than falling back to a captain turn.

```json
"cronjobs": {
  "advanced": true,
  "directory": "/srv/captain/cronjobs",
  "channel": "C123",
  "user": "U123"
}
```

The tool, local CLI JSON and `CRONJOB.md` frontmatter accept these extra fields:

```json
{
  "op": "add",
  "name": "quota-recovered",
  "description": "Check whether routine work can resume after a Codex reset",
  "trigger": { "type": "quota-reset", "provider": "codex" },
  "model": "openai-proxy/gpt-6-luna#low",
  "once": true,
  "arbiter": "twiki",
  "prompt": "Use the supplied quota observation to report whether the reset occurred. Return the numeric evidence."
}
```

Replace the model with an available route from the active profile. Omit `op`
for file frontmatter. Omit `schedule` for an event-only job, or keep a normal
five-field `schedule` to run on either clock or event. The slash Add form still
creates clock jobs; use the tool or a reviewed definition for the extra fields.
List and report include model, trigger, once and arbiter metadata. An omitted
model is shown as `captain`, meaning the captain's actual model at execution,
not a guessed provider default.

- `quota-reset` fires when a known window's raw `resetAt` moves forward by at
  least one hour and either usage drops by at least five percentage points or
  the previous `resetAt` has passed. This recognises weekly and early manual
  resets while rejecting timestamp jitter and multi-hour drift at unchanged
  usage. Other observations update the stored raw timestamp and usage silently.
  The first observation establishes the baseline without a reset event.
- `quota-threshold` uses the same provider selector and adds `usedPercent`,
  between 0 and 100. An initial observation already at or above the threshold
  fires once. It does not fire again for that account/window/reset cycle;
  utilisation noise does not rearm it. Only a reset meeting the rule above
  starts a new cycle; raw timestamp drift does not rearm the threshold.
- Both selectors accept optional `window` (`5h`, `weekly` or `other`) and
  `scope`. The default scope is `subscription`. Each account and window has
  separate state; a model-specific scope must be selected explicitly.
- The gateway reads the existing quota capability at most once a minute,
  without a model turn. Unavailable, inactive, stale, future-dated or incomplete
  observations do not imply quota. Reset-passed observations do not fire.
- Observation, event receipt and run admission commit together in private
  `cron.sqlite`. Restarts do not fire the same event twice. Events while a job
  is paused, unavailable or busy are consumed, not saved as a future backlog.
  Each pass admits at most 100 runs. The accepted task retains the numeric
  observation that caused it, including `previousResetAt` (null on bootstrap)
  and the new `resetAt`; no account email or credential is included. This
  payload accompanies both tools-off evaluation and direct captain execution.
  Deduplication uses a stable private account key, not the display ordinal;
  credential reordering does not rearm an event. Public quota tools and job
  prompts never contain that private key.

An explicit `model` or `arbiter` selects tools-off evaluation before any captain
turn or Slack announcement. This uses the OpenCode crew plugin's stateless
generation capability, not a new root or a change to the captain's model.
Creation and execution both validate the exact provider, model and reasoning
variant against the team's allowed providers and live model/agent catalogue.
Unavailable routes fail closed; there is no fallback. Without either field,
clock and event jobs continue through the existing captain execution path.

`arbiter: twiki` requires that exact configured Pi crew member. Its configured
model evaluates only the job's output and returns `act`, `ignore` or `escalate`.
It uses a separate tools-off decision store, not the durable Twiki conversation,
task slot or tools. The job evaluation also has no tools or previous context.
It can use its supplied input and event observation, not inspect files or make
changes. The captain receives the original task and evaluation only for `act`
or `escalate`. `ignore` stays private and is omitted from daily result excerpts.
Approval, credentials, destructive actions and owner decisions force escalation;
malformed or incomplete verdicts cannot authorise action. `act` still grants no
new authority. The captain must apply the normal approval rules before acting.

Evaluation claims and output are durable. Interrupted or uncertain evaluation
is held, never silently replayed. A retained verdict can resume delivery without
rerunning the models. Each evaluation has a 60-second deadline, including the
arbiter. A tick starts at most one new evaluation. A timed-out provider that
ignores cancellation holds that evaluation lane until it settles, but does not
block later clock jobs, quota polling or reports. No late output is delivered.
Private per-run Pi stores under the crew's `cron-evaluations` directory are
retained for operator inspection; this version has no automatic retention
cleanup. Treat them as private runtime state and include them in the normal
authorised data-retention procedure. `once: true` removes the schedule through
a durable tombstone only after its first successful run, including `ignore`.
Failure or uncertainty leaves it retained. Rediscovering the file does not
revive the removed job; use a new name for an intentional replacement.

Definition validation fails closed. If live model validation is temporarily
unavailable during file sync, the affected job becomes unavailable. An event
observed in that state is consumed, not backlogged, just like an explicitly
unavailable job. Once validation recovers, later events can run; the earlier
event is not replayed.

## Empty lists after configuration changes

`list` defaults to every destination for the bound bot, including DMs. Optional
`channel` and `user` filters are exact and reported in the response; they do not
default to the configured destination. `remove` finds the exact job ID across
the bot's destinations, with optional exact filters. It cannot remove another
bot's job. Add and manual run keep their configured-destination defaults.
For a calendar date that should run only once, set `once: true`: a five-field
expression alone repeats each year.

The gateway retains the active backend namespace until a restart. Tools read
the configuration file afresh. A restart-only backend or cron setting change
can therefore select a different namespace in the tool while the old gateway
still runs its jobs. Controls now refuse that mismatch before syncing files,
instead of returning a misleading empty list or creating duplicate schedules.
An absent database on a read operation is also an error, not a new empty store.

Compare the intended configuration with the running gateway and perform its
normal authorised restart. Do not delete cron state, move schedules to another
namespace or widen access to make the list appear. The scope fence diagnoses
this mechanism; it does not prove which setting caused a historical incident.

## System maintenance example

[`system-maintenance`](../cronjobs/system-maintenance/CRONJOB.md) is a
disabled example with a supporting policy. It covers OpenCode, Claude Code,
Codex, Pi, CLIProxyAPI, Stargate dependencies, AgentsView and Worktrunk. Copy it
only into the intended configured directory, review ownership and timing,
then explicitly enable it. The sample 03:15 UTC schedule is provisional.

Reuse an existing OS updater rather than installing a competing schedule.
A Stargate job can inspect that updater's private logs and include verified
results in the morning digest. Shared executable replacement needs a proven
idle window. Dependency or version pins require reviewed changes and tests;
live Stargate/proxy activation requires a separate deployment decision. A
schedule is not permission to interrupt workers or blindly restart itself.
