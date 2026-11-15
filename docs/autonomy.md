# Efficient, self-maintaining crews

Stargate's trusted crew can perform work directly. Delegation is useful for
independent work, not a required extra step for every implementation or repair.
The captain can implement while workers are busy. Research and coding labels
are specialisms, not restrictions on which assigned tasks a member can do.

## Direct tools and server-wide history

Set these fields in an explicitly trusted team's JSON:

```json
{
  "toolAccess": "direct",
  "historyScope": "server"
}
```

These are team fields, alongside `captain` and `crew`. They are not gateway
Slack access settings. `toolAccess` defaults to `curated`; `historyScope`
defaults to `team`. Generic gateway tool defaults remain unchanged.

Direct mode permits registered native tools, Code Mode, and connectors without
adding a grant for each new tool. It does not install missing tools or make an
unattached Desktop browser available. Use installed terminal tooling when the
Desktop browser is absent. Secret-file read exclusions remain at the end of
the permission list. Plugin operations still use their own task/session rules.

Server history scope reads all sessions on the configured authenticated
OpenCode server, including archived sessions and other projects or namespaces.
Use it to find earlier decisions and recover work without operator-assisted
transcript copying. The history tool does not change those sessions. Prefer
authenticated APIs over direct database access.

Apply permissions to both agent configuration and existing session rules when
updating a team. Updating a profile file alone does not rewrite stored session
permissions. Preserve session IDs, selected models, task IDs, and histories.
Keep the gateway backend permission configuration aligned for future sessions.

Workers can read their own task with `stargate_crew` `status`; they need not ask the
captain to inspect a task they are already executing.
They can also read their selected model and variant with
`stargate_model({ "op": "get", "target": "self" })`, without waiting for an idle
worker or changing the model. Model switching remains a captain operation.

## Operating approach

1. Read the actual failure and current configuration; do not inherit an old
   transcript's claim that a tool is unavailable.
2. Use the shortest available tool or authenticated API path.
3. Repair recoverable configuration or task-state problems and continue.
4. Reuse completed work. Do not restart an execution merely because result
   delivery or completion bookkeeping failed.
5. Escalate only unresolved problems that need operator input. State the
   blocker, attempts, and the smallest needed decision.

## Findings from the history review

The 2026-11-08 review paginated through 48 current and archived sessions and
3,247 messages. All session reads succeeded. Targeted checks found worker
`status` refused as captain-only, history scope hiding other namespaces,
convenience-tool failures, and older claims of unavailable shell/admin tools.
Shell, editing, and Code Mode were already allowed in the live team; adding
the same grants again would not fix those causes.

The review also found idle workers stranded by missed completion calls and
captain polling requirements for queued work. These are task-execution issues,
not evidence that every tool needs another permission or approval layer.
The crew recovers completed results from their exact submitted input rather
than require the operator to supply message IDs and hashes. A successful final
answer is enough; an explicit worker completion call remains optional. Captain
`status`, `wait` and the next `dispatch` check recover missed completion and
reuse the existing worker session. See [automatic crew result recovery](crew-recovery.md)
for result selection, retries and diagnostics.
