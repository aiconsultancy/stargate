# Crew activity in Slack

Pogo can show a separate **Crew activity** message in the requesting Slack
thread. It uses a native collapsible Slack container, initially collapsed.
The captain's streamed answer and final answer stay separate.

## Opt in

First configure [Twiki as a Pi Durable crew member](agents/default-opencode.md#pi-durable-crew).
The reporter must belong to the captain's team. It uses CLIProxyAPI and the
same persistent worker slot as maintenance; it does not need another Slack app
or OpenCode root session.

Add this field to the Slack bot's Pogo configuration:

```json
"crewActivity": {
  "detail": "summary",
  "reporter": "twiki"
}
```

- `off`: default. No reporting capture or summary request is started.
- `summary`: show report status and Twiki's concise, attributed summary.
- `detailed`: also show bounded assignments, explicit task messages and results,
  labelled with configured crew display names.

Apply Pogo configuration changes with an operator-approved gateway restart.
The OpenCode captain's plugin must include the reporting RPC implementation.
This feature does not expose Pi worker history through OpenCode history tools.

## Flow

The gateway opens a capture for one accepted captain request, using that
session and request ID. Setup has a one-second deadline; reporting failure
does not prevent the captain from answering.

Pogo collects linked task activity, not arbitrary transcripts or tool output.
The activity box appears only after actual crew entries are captured. An empty
capture does not start or queue a summary request. The reporter's own maintenance
and reporting tasks do not count as crew activity.
After the captain's turn, Twiki prepares one report through its normal crew
queue. Maintenance can delay the report, but reporting never waits in the
answer-delivery path. Pogo updates the same activity message in the original
thread. It does not prompt the captain again or let workers post to Slack.

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

Summary mode does not include raw activity entries. Detailed mode shows at
most eight bounded entries; omitted activity is marked as shortened. All
crew/model text renders as literal text, without Slack mentions or rich-markup
instructions. Only safe visible text is eligible; never show internal reasoning,
raw SDK errors, credential files or unrelated history.

Reporting is best effort and bounded. Gateway shutdown, cancellation, access
revocation or opting out stops further updates. Slack failures do not rerun
the captain, maintenance tools or a completed summary. Activity messages have
no separate delivery-retry queue; a crash or disconnect can leave the last
status visible. The gateway follows at most eight active reports. Collection
follows the request lifetime, not a separate five-minute timer. Completion
starts a bounded 30-second finalization period. Request cancellation stops
collection; cleanup uses a separate bounded signal so a visible box can show
its terminal status. Read or finalization failures change an existing box to
**Report unavailable**; they do not create an empty activity box.
No exactly-once delivery is claimed.

Active reads renew a 90-second capture lease. Abandoned captures expire lazily;
the reporting protocol allows up to 60 seconds for linked tasks after finish,
but the gateway's 30-second finalization limit can end the report sooner.
Capture cleanup runs on reporting operations after a one-day receipt window.
Sanitized report conversations remain in private Pi storage for deliberate
operator cleanup; they are not a public transcript archive.
