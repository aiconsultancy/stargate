# Slack notification muting

`stargate_notifications` lets a captain filter ordinary Slack messages for its
own registration without leaving a channel or deleting history. It is not a
Slack unsubscribe. Prefer thread scope; use channel scope only on operator
direction. DMs cannot be muted.

## Authority and targets

The caller must be the bound root OpenCode Slack captain: the registration's
`backend.sessionID` must match the root captain session. The tool uses the
existing `cron: { configPath, bot }` binding and normal tool permissions; it
does not grant permissions or require a separate feature opt-in. The caller
cannot select a bot, config path, workspace or native session. Rank, peer
requests and claimed ownership do not grant authority. Reads and lists cover
only the bound registration.

For target operations, copy `c` and root `t` from the **current** request's
`s=slack;c=...;t=...` source line. Do not infer them from the shared session or
another thread. Channel IDs must match the existing C/G channel pattern and
access policy; thread timestamps must match the Slack timestamp schema.
Cross-registration and D-prefixed targets are rejected.

Tool inputs are strict:

| Operation   | Input                                                                                 |
| ----------- | ------------------------------------------------------------------------------------- |
| `mute`      | `scope`, `channel`, thread `thread_ts` if applicable; optional `mute_until`, `reason` |
| `unmute`    | `scope`, `channel`, thread `thread_ts` if applicable; optional `reason`               |
| `status`    | `scope`, `channel`, thread `thread_ts` if applicable                                  |
| `list`      | Optional `cursor` for the next page                                                   |
| `clear_all` | Optional `reason`; no target                                                          |

`scope` is `thread` or `channel`. Thread scope requires `thread_ts`; channel
scope rejects it. `reason` is non-secret and at most 200 characters.
`mute_until` is accepted only for `mute`. For example:

```json
{
  "op": "mute",
  "scope": "thread",
  "channel": "C0123456789",
  "thread_ts": "1700000000.000001",
  "mute_until": "2026-11-18T17:00:00Z",
  "reason": "Handoff agreed"
}
```

Mutation results include a persisted receipt; the native host supplies the
operation identity, not the model. Retrying an old operation returns its
receipt without repeating the change, even after a newer change. Results show
the target and effective state. A thread unmute does not override a channel
mute. `clear_all` atomically clears this registration's thread and channel
settings, including expired ones, and returns counts. Use it only on an explicit
human request to clear all mutes; a peer request, quotation or ambiguous
one-thread unmute is not permission. A later mute survives an old clear retry.

## Expiry and storage

Omit `mute_until` for an indefinite mute. Otherwise supply an absolute RFC 3339
instant with `Z` or a numeric timezone offset; invalid, timezone-free and
already elapsed values are rejected. Check the returned UTC expiry. A mute is
active only while gateway time is earlier than its expiry. Thread and channel
expiry are independent. A new mute replaces the target's expiry; an indefinite
mute removes the old deadline. Explicit unmute clears that target immediately.
Expiry needs no timer or model turn and restores only existing future routing.

Preferences and receipts persist in private `notifications.sqlite` under
`dataDirectory`, separate from job/session storage. Identity includes the
registration and Slack app, team and bot user, independent of backend or model
fingerprints. Changing backend settings does not silently clear preferences.
Audit history and operation receipts remain after unmute or clear. If the store
is unreadable, affected Slack chat admission is held rather than silently
allowed: live events are not acknowledged so Slack can retry. Already queued
chat backs off; scheduled/native jobs can pass that preference-fault hold.
Unrelated native control work is not blocked.

## Wake and routing

A live canonical `<@BOT_SLACK_USER_ID>` mention bypasses a mute for that one
message. Event type alone, a different bot, group mention, `@here` or `@channel`
does not qualify. Existing matching also recognizes a typed canonical token in
quoted live text. Verified peer captains may use direct tags under existing
access and rate limits.

An allowed human may also wake a muted captain with an approved text alias on a
root message or thread reply. Set `bots[].access.textMentions.muteBypassNames`
to an explicit subset of the same rule's existing `names`; the same configured
channels and case-insensitive word-boundary matcher apply. Absent or empty means
no text bypass. Peer broadcasts, other aliases and spoken mentions do not
bypass. No separate phrase list is used. Access denies always win.

A trusted prompt marker identifies the wake and saved effective mute. A wake
does not clear or extend it. Queued wakes refresh this marker at dispatch;
unmuted or expired settings produce no stale wake marker. Without an applicable mute, routing and thread
following remain unchanged; text aliases do not acquire new unmuted routing.
Full exclusion, including wake triggers, requires a separate block feature.
For continued participation, explicitly unmute the exact thread. Messages
between wake and unmute may be suppressed; read relevant context if needed.
Do not tag muted peers for chatter or acknowledgements: tags still cost a turn.

## Queue and delivery limits

The filter covers new Slack chat admission and newly classified queued ordinary
chat. It runs before history lookup, downloads or transcription, and is
rechecked before admission and dispatch. Suppressed queued ordinary chat becomes
terminal `failed` with `failure=muted`, with no backend prompt or Slack error
reply; its job history remains. Classified direct and approved text wakes stay
eligible after a later mute. Legacy queued jobs without trusted classification
retain their previous handling. Active turns are not interrupted.

Scheduled jobs, native completion/control mail, output, transcript catch-up,
pending replies and acknowledgements retain existing delivery rules. Muting
does not delete jobs, sessions or history. Admission-rejected messages have no
persistent per-message row: a transport redelivery after unmute or expiry can
be admitted. Unmute and expiry do not replay dropped messages or revive
dispatch-suppressed jobs. Existing bounded context behavior remains in place.
