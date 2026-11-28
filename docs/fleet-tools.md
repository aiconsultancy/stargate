# Opt-in fleet tools

The OpenCode V2 fleet plugin provides `fleet_dispatch`,
`fleet_verify_instruction`, `fleet_status` and `fleet_answer_offer`. Nothing
enables these tools or opens a control listener by default. They do not replace native permissions,
repository instructions or human approval and deployment gates.

Optional [native PR review evidence](fleet-reviews.md) adds `fleet_review` only
when explicitly enabled. It binds full immutable review context to actual
native reviewers and exposes protected proof reads for a separate publication
and merge integration. It supplies no GitHub identity or human approval.

Each listener belongs to one configured gateway account and one pinned native
OpenCode root session. The gateway verifies the native assistant/tool input
ancestry for every call. The plugin passes its native session, agent, message
and tool-call IDs; none is a model-supplied argument. Before calling the socket,
each tool calls `ctx.permission.assert` with its own action and native tool
source. Denial stays a native denial.

The gateway independently applies a private copy of its trusted
`backend.permissions` to every operation. The rules are ordered, the last match
wins, and no match means deny. Fleet IPC supports exact patterns, `*`, and a
literal prefix followed by `*`. Potentially relevant unsupported patterns and
`ask` rules are rejected when fleet control is configured. A native approval
does not expand the gateway policy; use explicit allow/deny for these
fleet actions. Teams approval remains available for other native OpenCode tools.

The engine owns its native database. Matching the active native tool's agent,
call ID, name, input and ancestry establishes correlation, not authentication or
permission proof. During an active turn, that engine can invoke operations the
gateway policy explicitly permits. Keep this policy, gateway credentials and
the evidence database outside engine write access.

## Configure the gateway and plugin

The optional IRC `fleetControl` object declares a private socket, shared private
evidence ledger and explicit fleet destinations:

```json
{
  "fleetControl": {
    "socketPath": "/run/stargate/coordinator/fleet.sock",
    "statePath": "/var/lib/stargate/control/evidence.sqlite",
    "results": true,
    "targets": [
      {
        "id": "captain-one",
        "account": "captain-one",
        "role": "captain",
        "channel": "#captain-one",
        "sessionID": "ses_pinned_captain_one"
      }
    ]
  }
}
```

`results` is optional and defaults to off. Enable it on the dispatching IRC
gateway and every participating captain gateway to return settled outcomes to
the original IRC/Teams conversation. Related Teams registrations must share
the same pinned backend and fingerprint as the dispatching IRC gateway.
For a new fleet setup, add the registration's explicit `fleetChannels` metadata
and each target's real `role` to use the [role-aware IRC defaults](irc.md#configured-fleet-defaults).
Target roles are routing metadata, never human approval. Omitted/unknown roles
do not add automatic channel membership, and legacy configs without
`fleetChannels` keep their explicit membership and wake configuration.

Paths must be absolute and normalised. Every target needs its exact native
session pin; there is no lookup by a model-chosen account or channel. A target
cannot omit its pin. The listener also needs the dispatching gateway's existing
native root pin. A fresh or foreign session gets no authority through a claimed
agent name.

Load the plugin **directory**, which has its own package manifest, in OpenCode:

```json
{
  "plugins": [
    {
      "package": "/srv/stargate/plugins/opencode/fleet",
      "options": {
        "socketPath": "/run/stargate/coordinator/fleet.sock"
      }
    }
  ]
}
```

Existing OpenCode configurations can still load `/srv/stargate/src/fleet`
through a temporary forwarding package. Use the new path for new installs.
Configure only one of these paths, not both.

Allow the native actions only for the intended profile. The default
permissions remain deny. A profile may permit verification/status while denying
dispatch. Installing the plugin does not grant Subspace API, filesystem, shell
or deployment permission.

The socket directory must be owned by its gateway user, writable only by that
user, and traversable only by its own engine group. Its ancestors must also be
safe. The listener creates the socket as `0660` under the existing kernel-lock
and stale-socket guards. There is no TCP fallback.

The evidence directory is separate: make it setgid and accessible only to the
trusted gateway service group, for example `2770`. The database, WAL and SHM are
`0660` and share that group. Engine users must not be members of the gateway
group and must not read or write this directory. Keep installed code and gateway
credentials outside engine write access. These OS permissions are part of the
trust boundary; plugin permissions alone are not a sandbox.

## Answering an agent dispatch offer

`fleet_answer_offer({"offerID":"offer-…","answer":"accept"})` answers a
_Ready for agents_ offer that the fleet's rear admiral (the
`fleetControl.targets` entry with `role: "rear_admiral"`) addressed to this
captain in the command channel (see [agent dispatch](agent-dispatch.md)).
`answer` is `accept` or `decline`; an optional `reason` of up to 200
characters is shown to people only. The gateway accepts only an offer that
its authenticated IRC intake recorded for its own account in the last 24
hours. It sends the answer from its own IRC account as a `NOTICE` replying to
the offer, sends one answer per offer and returns `humanApproval: false`.
Accepting asks the rear admiral to assign the issue; it is not approval.
Allow `fleet_answer_offer` in the captain's gateway and native permissions;
the captain role's provisioned fleet permissions include it.

## Original instructions and authority

Authenticated gateway intake records a source after admission, before queueing
the turn. It retains the exact received text, authenticated account, transport,
channel/conversation, message ID, authority (`human`, `agent` or `context`),
optional agent rank, timestamp and owner session. No control-socket operation
can insert or modify evidence. A repeated transport delivery may have a later
local receipt time; the first timestamp is kept and every other field must
match. A reused reference with changed text or identity is refused.

`fleet_verify_instruction({"reference":"..."})` returns that exact record and
`humanApproval: false`. A session can read its own source records. It can read
another gateway's record only after an explicit gateway dispatch delegates that
reference to its configured target session. Other agents and foreign pins
cannot read it. This lets a captain retrieve the original Teams instruction
after a coordinator relays the assignment over IRC, without trusting a quote
generated by the coordinator.

Compare the original text and identity with the proposed work. Missing evidence
or an instruction that exceeds the retained scope needs human clarification.
The tools never turn historical human text, an agent rank or a relayed request
into human approval. Context-only sources cannot start assignments.

## Dispatch and recovery

`fleet_dispatch` accepts `target`, `text`, `sourceReference` and optional
`requestID`. The default request ID is the native tool-call ID. The gateway
selects the configured account/channel pair and labels delivery with its own
actual account, verified source reference and source authority, explicitly
marked **not human approval**. It never accepts an alternative sender identity.

Before any external delivery, one SQLite transaction records the request,
payload fingerprint, unknown outcome and target evidence delegation. On
confirmed transport completion, the outcome becomes `sent`. Exceptions,
cancellation and process death leave `unknown`: the message may already exist.
This is not an exactly-once delivery guarantee.

A repeated request with the same ID and payload returns the retained outcome
without sending again. Reusing the ID for different work is refused. Inspect
`fleet_status({"requestID":"..."})` and the destination before deciding how to
recover an unknown outcome. Do not switch to a new ID to blindly resend it.
With results enabled, status also includes a retained `completion` and
`resultQueued` when available. `resultQueued` means a continuation is durable
in the original gateway queue; it does not prove external delivery. Status
without a request ID reads configured targets and optional non-secret
transport state; it never wakes a captain.

## Correlated completion and recovery

With `fleetControl.results: true`, authenticated intake retains its immutable
queue namespace/event identity alongside the source. Dispatch resolves that
exact local job and native input; missing evidence, an old source without an
origin, or another registration's namespace fails closed. Do not replay an
old assignment to obtain a result route.

The gateway adds an opaque dispatch ID to the IRC assignment. At captain
intake, its real SASL sender, target account, joined channel, pinned session,
full payload and server message ID must match the retained delegation. The
first admitted event is claimed durably. A copied packet with another event
ID cannot start another execution. Ordinary enrolled peer chat can still start
an agent-context turn when it explicitly mentions the current nick and is not
addressed at its start to a different fleet recipient, within the existing
persistent peer cap. The accepted recipient is retained across nick changes;
current enrolment and access policy are still rechecked before work/delivery.
Reserved dispatch labels need exact retained
correlation and never fall back to ordinary chat. Only gateway-produced
correlated results can declare completion or select the durable return route;
ordinary peer text never acquires human approval. Captains return correlated
outcomes through the durable outbox below.

A human or ordinary peer message explicitly addressed at its start to another known fleet
account or target ID (`vance:` or `vance,`) does not separately wake this
captain because its name occurs later, except where protected human wake rules
explicitly deliver a home/command request. A reply tag alone does not override
the recipient. Other human requests retain their ordinary access rules.
Results-mode human queued text retains its leading address so recovery uses
the same recipient rule, including correctly addressed nested prefixes. Old
queued text beginning with a different fleet recipient is refused without
rewriting the record or guessing an address removed by an older gateway.

Only the trusted gateway result worker can publish completion. Engine IPC has
no completion operation. The worker binds the persisted native input to its
admitted delegation and retains settled public text, actual actor, native
session/input, and reported native assistant/agent/provider/model identifiers.
It reads maker evidence from that exact native input, excluding later requests;
it does not guess from configured model defaults or claim to independently
verify an upstream model behind a proxy. Reasoning and tool payloads are not
part of the completion. Missing native evidence, interruption or other failed
outcomes are `uncertain`; recovery never resubmits the work.

The shared ledger retains the outcome before delivery. Its owner resolves the
original ingress job and requires its original native input to still match.
It queues one deduplicated continuation with the original conversation, thread
and delivery recipient. A later human request cannot select that destination.
The model sees `s=fleet`, the captain's identity and `agent` authority. The
recipient remains available only for current delivery access checks. This is
agent context: it cannot expand human authorisation or request a Teams human
permission decision. Historical human approval tokens cannot be borrowed.

Queueing precedes ledger acknowledgement. A crash between those steps finds
the same durable continuation after restart; it does not run the captain or
coordinator twice. If a continuation's native execution is interrupted, the
normal gateway recovery reports its uncertain outcome instead of replaying
it. Access checks receive the immutable stored job correlation before work
and delivery. Ordinary peer jobs queued by an older results-mode gateway are
refused through that normal access path, including pending replies; their
records remain retained. Genuine persisted assignment and result jobs retain
their correlation and follow the normal recovery rules. Do not delete or
replay old peer jobs to recover the conversation.

External delivery retains the gateway's existing retry/uncertainty rules;
this is not an exactly-once delivery guarantee. An unavailable original job
leaves the result pending and visible through status; it never falls back to
the latest conversation.

The initial IRC write still has `sent`/`unknown` transport semantics. A crash
between claiming intake and persisting its queue can leave an assignment
unconfirmed. Inspect retained status, native history and destination before
operator recovery; neither a new event ID nor a new request ID is a safe
blind resend. Disabling results preserves existing receipt-only operation.

## Deferred crew results

Use `fleet_defer_result` with the crew `taskID` during its original correlated
fleet assignment. A captain can then send progress and end the current turn.
When that task finishes, the crew wake reaches the same captain, which checks
the saved result and sends its final answer. The gateway verifies the exact
task wake and its native origin before returning that answer to the source.
Unknown results remain pending until evidence is available or the 24-hour
deadline is reached. Confirm the existing task's status before trying to
recover work.

This requires durable fleet results, a pinned OpenCode captain with
`completionWake: true`, `deferredResults: true` in its `stargate.fleet` plugin
options, and the `fleet_defer_result` permission on `crew` both in the native
profile and the fleet gateway policy.

## Gateway integration

`FleetControl.open` takes `config`, the immutable `sessionID` and actual
`account`, an explicit `allowDispatch` capability (default `false`), plus mandatory `authorize(caller, signal)` and
`send(target, text, signal)` callbacks. The authorizer must verify the retained
native message/input ancestry, not the latest chat sender. The transport callback
must respect cancellation and current destination access checks. Its completion
confirms transport completion only, not captain execution.

Call `recordSource` only with authenticated intake evidence; the owner pin is
implicit. Close the control listener during gateway shutdown before closing its
transport. The ledger is shared by trusted gateways, while each listener still
authorizes only its own native pin.

Set `allowDispatch` from the gateway's configured fleet-policy capability.
The server checks it independently of the plugin's native permission check, so
a direct socket request from an engine cannot bypass a disabled capability.

Focused tests use real local Unix sockets, SQLite and fake transport/native-host
callbacks, with no provider calls:

```sh
bun test tests/fleet-tools.test.ts tests/fleet-results.test.ts
```

## Enable captain peer messages

Load the captain's OpenCode crew plugin before the fleet plugin and set
`peerMessages: true` in the fleet plugin options. Allow `fleet_peer_message` on the gateway
for the exact fleet target IDs that captain may contact. The existing native
`stargate_mail` grant still governs use of the crew tool. The gateway requires
a pinned active native tool call, an enrolled captain target and a joined,
permitted channel. Set the target's `role` to `captain`. Provide
`fleetChannels.command` if command-channel routing is needed.

With `peerMessages` enabled, `stargate_dm` advertises `via: "ship"` or
`via: "command"` for cross-ship chat. Send 1–1,800 characters on one line,
without `@` or control characters. Omit `via` for local-team mail.
Fleet peer messages carry agent identity and no approval authority. Use
`fleet_dispatch` for work that needs a retained instruction or review context.
