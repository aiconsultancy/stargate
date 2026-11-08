# Crew activity in Slack

Pogo can show a separate **Crew activity** message in the requesting Slack
thread. It uses a native collapsible Slack container, initially collapsed.
The captain's streamed answer and final answer stay separate.

## Query a member

Use the existing `/pogo` command in an allowed channel:

- `/pogo crew`: show the configured crew roster and task summaries.
- `/pogo crew twiki`: show Twiki's current stored task, queue, last stored
  outcome and recent task status. Replace `twiki` with another crew ID.

The private modal opens before the backend read. This query calls no model,
creates no captain or worker conversation, and does not start, promote, retry,
recover or reconcile work. Normal bot user and channel access rules apply;
pairing-operator access is not required. It uses the same authenticated,
location-scoped captain plugin RPC as crew reports. No additional Slack app or
permission is needed. An older plugin or a backend without crew status support
shows an unavailable notice. A standalone Pi bot is not a crew captain.

The view reads durable crew task state. For Pi workers, it also shows whether
this OpenCode process observes an in-flight task. That observation is not a
health check. A stored `running` or `ready` value does not prove execution is
live. `uncertain` means there is no confirmed outcome; the query does not repair
or replay that task. Legacy task times and summaries remain unknown.
OpenCode execution is labelled unobserved; the query does not fetch native
session transcripts. Close and run the command again to refresh the snapshot.

This view is independent of automatic turn reports and works when
`crewActivity` is off. It includes the reporter's own maintenance and reporting
tasks, which automatic turn captures deliberately exclude. Assignment summaries
are limited to 180 characters. Pi's visible-text callback supplies a coalesced,
400-character progress snapshot; reasoning, tool output and raw final results
are not copied into status. Report task summaries use a fixed label, not their
input records. Recognized credentials are redacted before persistence and
display. Do not put secrets in assignments or visible answers: redaction cannot
identify all secrets.

The roster shows at most 20 members; a direct member query can select an omitted
member. Each detail view shows the first five queued tasks and eight recent
outcomes, with total counts and explicit truncation notices. Private status
metadata retains active and queued tasks plus 12 recent tasks per member.
Existing task results, mail, notices and Pi histories are not removed. Status
metadata has no transcript browser or complete event archive. Some legacy and
older retained outcomes have no timing or progress details.

## Opt in

No reporter is required. Pogo renders journal facts directly. To add one final
summary, configure a Pi Durable colleague with tools-off reporting support and
set its exact configured ID as `reporter`. It shares its normal worker slot;
reporting does not reserve a second owner or wait behind busy maintenance.

Add this field to the Slack bot's Pogo configuration:

```json
"crewActivity": {
  "detail": "summary"
}
```

- `off`: default. No reporting capture or summary request is started.
- `summary`: show a current final summary or the latest five attributed facts.
- `detailed`: also show bounded assignments, explicit task messages and results,
  labelled with configured crew display names.

Apply Pogo configuration changes with an operator-approved gateway restart.
The OpenCode captain's plugin must include the reporting RPC implementation.
This feature does not expose Pi worker history through OpenCode history tools.

## Flow

The gateway opens a capture for one accepted captain request, using that
session and request ID. Setup has a one-second deadline; reporting failure
does not prevent the captain from answering.

Pogo collects scoped journal facts, not arbitrary transcripts or tool output.
The activity box appears only after actual crew entries are captured. An empty
capture does not start or queue a summary request. The reporter's own maintenance
and reporting tasks do not count as crew activity.
Journal entries have monotonic IDs, host timestamps, member identity and an
optional task reference. They remain in the private crew database when captures
expire. Agents record milestones, checks, blockers and outcomes, not tool calls.
Task transitions add reliable lifecycle facts.
After the captain's turn, a configured, supported and free reporter may prepare
one final summary. Busy, queued, uncertain or unavailable reporters are skipped
with an explanation; facts remain visible. Refreshes do not call a model.
Pogo edits the same activity message in the original thread. It does not prompt
the captain again or let workers post to Slack.

Accepted summary jobs belong to the reporter, not the short reporting RPC.
Ending that RPC does not cancel an accepted job. Explicit capture cancellation
and plugin shutdown abort and drain pending admission; running Pi work remains
subject to the existing report cancellation and backend shutdown paths.

Each summary uses a fresh, tools-free Pi context containing only sanitized
capture records. Twiki's maintenance conversation and earlier reports are not
model context for a new report. The same worker slot and queue still control
admission, so reporting does not bypass maintenance ownership.

Detailed updates reflect task events, messages and completed results, not a
token-by-token copy of every worker's output. Private reasoning events are
never collected. Summary generation uses additional model quota.

## Privacy and limits

Captures bind activity to the originating captain request. Reusing a worker
or captain session does not add another thread's tasks to that capture.
Recognized credential forms are redacted before activity storage, summary
input and Slack output. Do not put secrets in assignments or task messages;
pattern matching cannot identify every possible secret. Historical context
already available to a worker is not a public activity transcript.

Summary mode shows the latest five fact lines when no current model summary is
available. Detailed mode shows at
most eight bounded entries; omitted activity is marked as shortened. All
crew/model text renders as literal text, without Slack mentions or rich-markup
instructions. Only safe visible text is eligible; never show internal reasoning,
raw SDK errors, credential files or unrelated history.

Reporting is best effort and bounded. Stop, access revocation and opt-out cancel
collection. Timeout and backend failure finish it. Shutdown detaches the loop
and preserves the durable capture. Slack failures never rerun tools or a model.
The gateway persists `{ts, capture, revision, done}` with the accepted job.
Restart and transcript settlement refresh the newest saved box through read,
not a new capture. Terminal boxes can show later facts without another summary.
Eight live captures and 32 post-response loops have separate limits. After the
reply, polling runs about every 15 seconds with a ten-minute collection ceiling
and one extra poll interval for the terminal read. Saved completed/stopped
captures use passive reads that cannot admit a reporter. Missing
or expired captures stop retries. There is no second delivery queue.
No exactly-once delivery is claimed.

Active reads renew a 90-second capture lease. Abandoned captures expire lazily;
the reporting protocol allows ten minutes for linked tasks after finish.
Capture cleanup runs on reporting operations after a one-day receipt window.
Sanitized report conversations remain in private Pi storage for deliberate
operator cleanup; they are not a public transcript archive.

Each capture owns a journal sequence range. A newer request closes the earlier
range. `greybeard:` late facts then belong to the newest box in that exact
captain thread, with the actual member and task attribution. Earlier journal
history remains available. Report tasks do not enter their own source journal.
Ship the gateway and plugin together: `note` is now a valid entry kind and
task-free entries omit `taskID`. `summaryCurrent` identifies a current model
summary; status/error explanations never suppress the factual view.
Existing legacy activity tables are preserved;
ordinary one-day capture cleanup still removes their old capture data.
