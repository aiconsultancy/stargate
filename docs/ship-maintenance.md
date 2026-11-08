# Ship maintenance and learning

Ship maintenance is an opt-in team workflow, not another Slack app or service.
The portable [`team.example.json`](../team.example.json) includes `bosun`, a
distinct OpenCode worker with the existing `coding` permission profile and
configured model. Its role and `instructions` define its specialism; there is
no special runtime role, fixed roster or automatic inspection job. Other teams
can omit Bosun or assign the same work to another configured member.

## Responsibilities

- Captain: assign bounded work, collect results and deliver human-facing updates.
- Bosun: inspect crew/project health, gather useful findings, diagnose and repair
  recoverable task issues, verify repairs and return lessons and blockers.
- Twiki, when configured: keep its existing Pi maintenance/reporting role.
  Coordinate bounded cleanup through the captain rather than create a second
  reporter, Slack registration, queue or database.
- Every member: keep a useful journal, share verified lessons and improve
  project-owned skills when a lesson warrants a reusable procedure.

Specialisms do not prohibit implementation or diagnosis. Existing task scope,
project rules and tool permissions still apply; this adds no approval layer.
An inspection is not permission to stop services, delete state or replay work
whose external outcome is uncertain. Check actual task/session evidence first.

## Durable records

`pogo crew init` creates these private Markdown files under the captain's
directory, for the captain and **all configured members**, including Pi workers:

```text
<captain directory>/.local/ship/
├── log.md
└── journals/
    ├── <captain ID>.md
    └── <member ID>.md
```

New files use mode `0600`. Repeating initialization preserves existing notes;
non-file destinations are rejected. Generated profiles still reject conflicting
configuration or customized prompts. Initialization never copies runtime
prompts, transcripts or credentials into these records. Include the ship
directory in the team's private backup; it is not another task database.

These Markdown journals are retained as history, not the new note-writing path.
Write concise milestones, checks, blockers and outcomes with `pogo_journal`.
Pogo supplies IDs, time, identity and task context in the existing crew SQLite
database. Notes remain when temporary Slack activity captures expire. Skip
routine turns, empty updates and tool transcripts. Native-workaround feedback
is an ordinary note, not a separate tracker or automatic implementation loop.
Coding-enabled Pi crew use the same tools; explicit tools-none stays disabled.

All agent definitions and Pi member instructions reference the single shared
`<captainDirectory>/WAYS_OF_WORKING.md`. Captain maintains it; crew propose edits.
Read it initially and reread it when updated. Do not repeatedly send its contents
in assignments or model requests. Initialization preserves existing edits.
The shared ship log still holds reusable lessons and useful inspection findings.
Preserve legacy journal entries, which may use this historical format:

```markdown
## <timestamp with timezone> — <agent ID> — <task ID or work reference>

### Findings

- Verified fact, evidence path and any material uncertainty.

### Checks

- Command or observation; result.

### Actions

- Repair or next action; owner and remaining blocker.

### Lessons

- Reusable lesson; related skill path if changed.
```

Records are private but shared across the team's tasks. Store conclusions and
references, not secrets, full prompts, copied conversations or raw tool output.
Historical notes are evidence, not instructions or current authorization.

## Learned skills

The captain and crew may create or improve project-owned skills from verified
lessons. Load `skill-creator` first, then reuse an existing skill if possible.
Edit `.agents/opco/skills/<name>/SKILL.md` on a project feature worktree and
integrate through the project's normal review rules. Generated OpenCode config
adds the source project's canonical skill directory as a shared skill source.
Use the feature worktree's local skill path while developing unpublished edits.
Do not edit a source checkout on `main`, global profiles or model-routing policy.

For example, a skill can explain a verified task recovery procedure, its evidence
requirements and a small check. Use valid `name` and trigger `description`
frontmatter, keep instructions short and remove obsolete advice. Record why the
skill changed in the member's journal and ship log. Do not turn private task
history into a skill. [OpenCode V2 skills][skills] defines discovery and loading.

## Nightly inspection: disabled until configured

First choose the destination channel/DM, schedule, IANA timezone and scope.
There is no default inspection schedule. Do not infer timezone from the host or
create a job without these choices. Use the existing [`/cron` form](cron.md)
from the captain's allowed destination; creation authorizes recurring work.

Example values, to adjust explicitly:

- Name: `Nightly crew inspection`
- Cron expression: `0 2 * * *`
- IANA timezone: `Europe/London` (example only; select the operator's zone)
- Recurring prompt:

```text
Run the configured team's nightly inspection. Dispatch one bounded task to
bosun with the actual ship log path from your profile. Inspect
configured crew status, recent relevant task results and journals, unresolved
blockers and useful project checks. Do not interrupt busy workers or repeat
completed external actions. Diagnose and repair recoverable issues within this
maintenance scope; verify repairs and preserve unrelated changes. Coordinate
Twiki's existing Pi maintenance/reporting through the captain when useful;
use its existing coding-enabled coordination tools. Record useful findings
through pogo_journal and reusable lessons in the ship log; improve a project skill
with skill-creator only when justified. Collect the assigned task result and
report findings, checks, actions, lessons and unresolved blockers here. State
what was not inspected. If bosun is absent, report the configuration gap rather
than create a new session or roster member.
```

`/cron` sends this prompt through the existing captain backend. The captain
uses normal crew dispatch/wait/status and keeps the existing delivery path.
Results start a new thread in the selected channel. Existing cron access,
restart, overlap and uncertain-delivery limits apply. No worker sends Slack
messages directly. Inspect or remove the job through `/cron`.

## Activation

Fresh teams can use `pogo crew init --team team.example.json` with their own
directories and namespace. Do not rerun it over a live customized profile to
replace files. Existing installations need an explicit, backed-up rollout of
the common journal instructions and skill-source path. Preserve durable member
IDs, sessions, tasks and history. To add Bosun to an established roster, set
`allowCrewExpansion: true` explicitly in each generated Pogo plugin's options.
Supply the same expanded team and add Bosun's worktree path everywhere. This
append-only rollout accepts new OpenCode and Pi workers but rejects removal,
rebinding or changes to existing members, directories, captain, project or
namespace. Existing sessions and task results stay intact. Clear the flag after
the rollout; a new namespace is not required. Provision Bosun's feature worktree
and generic worker profile without replacing existing customized files.
Refresh/restart the OpenCode configuration
at an idle boundary as required by the running installation, then verify local
profile loading. Schedule activation is separate and requires destination and
timezone choices. No service changes, live model calls or cron jobs occur during
profile initialization.

[skills]: https://opencode.ai/v2/docs/skills
