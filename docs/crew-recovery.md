# Automatic crew result recovery

An OpenCode worker's successful final answer is enough to finish its task.
The worker can still call `pogo_crew complete`, but a missed tool call does not
require a human to supply message IDs, hashes or a copied result.

The captain's `status`, `wait` and next `dispatch` check recover results from
idle workers. A check of a queued task can also recover the previous task
before promoting the FIFO head. This does not add a background queue scheduler
or send an unsolicited Slack reply.

## Result selection

Pogo checks the existing worker session's identity and successful native
execution outcome. It reads that session's messages backwards through the
authenticated OpenCode API until it reaches the saved task `inputID`. The input
must contain the original task envelope and captain metadata. The last completed
assistant answer must belong to that worker. Task-scoped synthetic urgency
notices keep the original result boundary when their target task and captain
metadata match. A later user input, unrelated synthetic input or standalone
shell input prevents selection of an unrelated answer.

Normal skill, compaction and model records do not prevent recovery. Only visible
answer text is stored, up to 64,000 characters, as for Pi worker results. Pogo
does not use private reasoning as a result.

Recovery can complete `running` and `uncertain` tasks. It updates only the same
retained task tuple and status; concurrent explicit completion takes precedence.
The next dispatch can reuse the original worker session after recovery. No
assignment is resubmitted, and no session is created, replaced or interrupted
by result recovery.

## When a result is not available

An active worker remains active. An interrupted or failed worker, a missing
answer, a changed task boundary or unavailable history returns an `uncertain`
status with a `diagnostic`. The diagnostic identifies the task and worker session
and gives the next action. For a temporary API failure, retry `status`. A later
successful final answer can recover the same uncertain task. Interrupted work
does not restart automatically.

The plugin uses the existing same-server history connection. Managed discovery
does not start another OpenCode server. If discovery is unavailable, configure
`team.historyAPI` for the existing server. History reads use the caller's abort
signal and a ten-second recovery timeout. Pogo does not read runtime databases.
