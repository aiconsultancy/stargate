# OpenCode captain/crew profiles

Pogo's **opt-in OpenCode agent profile** uses CLIProxyAPI and a Slack-facing
captain. Without `--team`, the starter captain is Bowser. It does not change
the gateway's fail-closed permission defaults. Use this profile only for
trusted Slack users: the coding
crew can edit files and run commands under the OpenCode service's OS account.

## Starter roles

| Primary agent | Role                                                                       | Lifetime                                   |
| ------------- | -------------------------------------------------------------------------- | ------------------------------------------ |
| Bowser        | Answer simple questions; coordinate substantial work; return Slack replies | One existing Pogo session per Slack thread |
| Mario         | Backend and general implementation                                         | One durable session per bot                |
| Luigi         | Frontend and integration implementation                                    | One durable session per bot                |
| Daisy         | Documentation/Linear research; assigned ticket updates and comments        | One durable session per bot                |
| Toad          | Verification and review                                                    | One durable session per bot                |

Crew sessions are root OpenCode sessions, not temporary children of a Slack
thread. The captain creates them lazily through the V2 API and reuses them.
There is one per configured member, across all the team's threads. Each member
has a named worktree and manages feature branches there. Never work on or
commit to `main` or `master`. The captain workspace stores coordination state,
not another implementation checkout.

Crew may use temporary model-named child agents, but must consult the global
[`agent-profiles` routing skill](agent-profiles.md) before selecting one.
The default global child profiles also use CLIProxyAPI, not direct-provider
fallbacks. Global profile switches do not change a crew session's stored model.
They must never create additional root sessions. Research-profile file,
shell, and Code Mode restrictions also constrain child agents. All crew roles
may use Linear read/write tools for their assigned tasks, including ticket
updates and comments. This is not permission for unrelated changes or
workspace administration. Follow the target project's delivery rules.

## Configured teams

Copy [`team.example.json`](../../team.example.json), a portable Galactica team
with captain `adama` and three workers, including researcher `gaeta`:

```sh
pogo crew init --team team.example.json \
  --directory /srv/pogo/galactica/captain --project /srv/project \
  --worktrees /srv/pogo/galactica/crew --base origin/main
```

Team JSON contains `captain: { id, name?, model?, instructions? }` and a
nonempty `crew` array. Each worker has the same identity fields plus `role`
and `permissionProfile` (`coding` or `research`). IDs use lowercase letters,
digits, `_` and `-`, at most 64 characters. IDs must be unique and distinct
from the captain. `captain` is reserved as a worker-message recipient.
Names/instructions are non-secret text, not credentials. Unknown fields fail.
Optional `historyScope` is `team` (default) or explicit `project`. Captain and
crew use `pogo_history` to search OpenCode history through the API. Project
scope may include other conversations in the target project; approve that
privacy expansion deliberately. Do not copy unrelated transcripts to Slack.

History uses the same server's HTTP message API: the plugin SDK has no full
message-list API. Managed `Service.discover()` runs on the OpenCode server host
and verifies the caller against the native plugin session. It never starts a
server. For non-managed servers or unavailable discovery, add an explicit
endpoint to team JSON, for example:

```json
"historyAPI": {
  "url": "http://127.0.0.1:4096",
  "headersEnv": { "authorization": "OPENCODE_AUTHORIZATION" }
}
```

Remote endpoints require HTTPS; loopback may use HTTP. URL credentials are
invalid. Header environment references must exist in the **OpenCode service's**
environment, not just Pogo's shell. Never put header values in team JSON.
Without a verified endpoint, history is unavailable; there is no DB fallback.

Permissions follow the explicit profile, never a name. Models use
`provider/model#variant` (variant optional) and become `agents[id].model`.
Omitted models use the existing template default. The engine selects configured
worker models when creating sessions; existing sessions keep stored models.
Optional `modelProviders` bounds model-tool discovery/switches. It defaults to
`["openai-proxy", "claude-proxy", "go-proxy"]`; there is no silent fallback to
another provider. The example records this allowlist explicitly.
For the gateway captain session, select `backend.agent` and, when needed,
`backend.model` explicitly; changing agents does not replace a stored model.

The namespace defaults to the captain ID (`adama` here); `--id` overrides it.
Worktrees use member IDs and branches `crew/<namespace>-<member ID>`.
Multiple teams may use one OpenCode server: give each its own namespace,
captain directory, private state directory and crew worktree parent. Reusing
IDs in separate teams does not merge their sessions. Generated plugin options
carry the validated team; omitted team options retain the legacy starter.

For example, keep Galactica (`adama`, namespace `galactica`) and Pegasus
(`cain`, namespace `pegasus`) on the same `http://127.0.0.1:4096` server. Give
each a team JSON file and disjoint directories:

```sh
pogo crew init --team galactica.json --id galactica \
  --directory /srv/pogo/galactica/captain --project /srv/project \
  --worktrees /srv/pogo/galactica/crew --base origin/main
pogo crew init --team pegasus.json --id pegasus \
  --directory /srv/pogo/pegasus/captain --project /srv/project \
  --worktrees /srv/pogo/pegasus/crew --base origin/main
```

Set both registrations' `backend.url` to that service, but use their own
generated directory, captain agent and permission rules, and distinct Slack
app registrations. State stays under each captain's `.local/pogo-crew`.

Do not silently rebind persisted identities to another roster, path or captain.
Initial roster IDs/directories remain fixed once persisted, including legacy
starter states. Keep existing state and sessions. Use fresh directories and a
new namespace for a changed roster, or plan an explicit migration. Model
changes use the explicit session-switch operation below. Setup refuses
conflicting overlays; it does not overwrite a live Bowser installation.
Existing sessions also keep their stored permission rules. New agent defaults
do not grant history/model tools to old sessions; update session permissions
only during an operator-approved rollout.

## Linear connection

Configure Linear once in the user's global OpenCode configuration; generated
crew profiles inherit it rather than overriding it with a read-only endpoint:

```json
{
  "mcp": {
    "servers": {
      "linear": {
        "type": "remote",
        "url": "https://mcp.linear.app/mcp",
        "codemode": false
      }
    }
  }
}
```

Merge this with existing configuration, never replace the whole file. Remote
OAuth is enabled by default; the standard Linear endpoint requests read/write
access. Direct tools let Daisy use Linear without shell or arbitrary Code
Mode access. From any OpenCode workspace, open `/mcps`, select `linear`, and
complete the operator sign-in; a terminal is not required. On a remote iPad,
paste an unreachable callback URL into the sign-in dialog, not agent chat.
Keep OAuth credentials outside the configuration. A fresh machine needs its
own sign-in. Configuration alone is not a verified connection: check status
and one read-only call before any explicitly authorised write.

## Fresh-machine setup

1. Check out Pogo and the target project. Install mise and OpenCode V2.
2. Run `mise install` and `make deps`. This includes the pinned Mesij CLI.
3. Follow [CLIProxyAPI bootstrap](../cliproxyapi.md). Provider subscription
   sign-in and private credentials are separate from Slack authentication.
4. Have the setup model follow the [global agent-profile gist](agent-profiles.md).
   Review its discovered mappings and approve required migrations first.
5. Create the starter configuration and worktrees (or use `--team` above):

```sh
make crew-init ARGS='--directory /srv/pogo/bowser --project /srv/indra --worktrees /srv/pogo/indra-crew --id bowser --base origin/main'
```

The captain and crew directories must not be nested inside each other's
OpenCode configuration tree. The source checkout is not switched, reset, or
cleaned. New branches start at the explicitly selected committed ref. Fetch
that ref first when current upstream code is required. Existing worktrees are
reused only for the same Git project on a non-main branch. Local Git excludes
keep generated overlays and persona files out of project commits.

The command refuses conflicting files; it never replaces custom instructions
or tracked project config. If `.agents/opco` exists, it uses that canonical
directory and requires `.opencode` to be its compatibility symlink. Otherwise
it uses `.opencode/agents/` and `.opencode/opencode.json`.

The default provider key reference is `{env:CLIPROXYAPI_API_KEY}`. That variable
must exist in the **OpenCode service's** environment, not merely Pogo's shell.
Alternatively, reference an existing private key file without exposing it:

```sh
make crew-init ARGS='--directory /srv/pogo/bowser --project /srv/indra --worktrees /srv/pogo/indra-crew --proxy-key-file /srv/private/proxy-client.key'
```

Never pass a token value in `ARGS`. This command does not install/start a
service, create Slack apps, start model work, or change global authentication.
OpenCode reloads local configuration after a save.

6. Use [batch Slack provisioning](../setup.md) to create or reuse bot apps.
   Register only the captain, not workers, with Pogo. Use the setup output's
   `directory` and `agent` for `backend.directory` and `backend.agent`
   (`bowser` for the starter, `adama` for Galactica).
7. For this trusted profile, copy the output's `permissions` array to
   `backend.permissions` (also in `agents[<captain ID>].permissions`).
   A session-level deny-all overrides agent allows; leaving that gateway
   default in place intentionally blocks tools.
   Keep the ordinary deny-all default for bots not using this profile.
8. Verify config, native agent/model/plugin loading, then a human Slack mention
   and a same-thread follow-up. Do not start a second Socket Mode listener for
   an app already running elsewhere; arrange an explicit handover.

## Providers and compaction

The committed `templates/opencode.json` is the portable base. It defines
`openai-proxy`, `claude-proxy`, and `go-proxy`, all through
`http://127.0.0.1:8317/v1`. The default remains
`openai-proxy/gpt-6.1-sol`. Go aliases use `opencode-go/<model-id>` upstream,
so their quota does not silently mix with Codex or Claude routes. Definitions
are not proof of subscription access; verify proxy and native model discovery.

```json
{
  "compaction": {
    "auto": true,
    "buffer": "20%",
    "keep": { "tokens": 15000 }
  },
  "experimental": { "background_compaction": true }
}
```

The buffer keeps 20% of context free, applying compaction around 80% usage.
Background summary preparation starts earlier, normally 60k tokens before that
threshold. Held summaries are in memory and can be lost on restart. They cost
tokens even when never applied. Native provider compaction does not use this
background-summary mechanism. See [V2 compaction][compaction].

The captain can discover models and switch its own or a worker's session model
with `pogo_model`. Load `agent-profiles` before selecting a route. Optional
`compactFirst` waits for worker compaction completion before switching workers.
For a running captain, self-compaction is admitted for the next safe point;
the tool cannot wait for its own running turn. Report admission separately from
completion. That call leaves the model unchanged; after compaction finishes,
call `switch` again with `compactFirst: false`.
Native `session.switchModel` affects subsequent provider turns,
not an already running response, and does not change global configuration.
Workers request durable model switches from the captain.

For example, these are tool inputs, not shell commands:

```json
{
  "op": "switch",
  "target": "starbuck",
  "providerID": "openai-proxy",
  "id": "gpt-6.1-sol",
  "compactFirst": true
}
```

Use `pogo_history` with `{"op":"search","query":"authentication migration"}`
to find prior user/assistant text. Follow its returned cursor while `partial`
is true. Searches are bounded API scans, not a semantic index. They omit
reasoning, system prompts and raw tool output, and return historical text as
untrusted data. Compaction does not remove the stored transcript.

## Coordination and limits

Mesij stores ordinary crew messages. Stable bot-scoped identities, inbox
cursors, worker session IDs, and task ownership belong to the crew integration.
Only the originating captain's task receives its result. Do not route by the
last captain to use a worker. Only one assignment can be active per crew member;
busy members are reused after completion, not replaced by additional sessions.

The captain uses role and prior task/history evidence for assignment affinity;
there is no automatic semantic matcher. For urgent work prefer a suitable idle
member over waiting for an experienced busy member. If all suitable members
are busy, `dispatch` with `queue: true` explicitly opts into a bounded durable
FIFO queue per member, up to 100 queued tasks. Without that flag, busy dispatch
returns `busy` and is not queued. A captain must poll `status` or `wait` on the
FIFO head to advance queued work after the worker becomes idle. There is no
background scheduler: a queue left without polling stays pending.

### Persistent sessions and tasks

OpenCode stores session transcripts and selected models. Pogo's separate crew
SQLite database stores the configured member-to-session registry, task IDs,
originating captain session IDs, status, results, notices and mail cursors.
Queued tasks also retain their input text. Pogo's gateway database separately
tracks Slack requests and reply delivery; these are not interchangeable stores.

1. `ensure` reserves a stable session ID before calling OpenCode. An uncertain
   create is inspected using that ID, not retried with a new identity. Missing
   previously confirmed sessions require recovery, not automatic replacement.
2. `dispatch` reserves one active task per worker in a SQLite transaction,
   then submits a uniquely identified input to that worker's existing session.
   An explicit queued assignment remains unsubmitted until promoted.
3. The assigned worker calls `complete` with the task ID and result. A final
   assistant message alone does not mark the task complete. Only its originating
   captain session can collect that task's result through the crew tool.
4. A completed slot is reused only after OpenCode confirms the worker is idle.
   Results remain stored after reuse. Queued jobs keep FIFO order per member.
5. Ambiguous admission, interrupted execution or missing completion can leave
   a task `uncertain`. It blocks slot reuse and is never automatically replayed.
   Cancelling a queued wait cancels that pending job, not another active job.

Model/compaction controls reserve the worker against concurrent dispatch.
A process crash can leave a durable control reservation; reconcile it with the
actual session before further work. Do not delete state or steal controls.
Durable tracking does not guarantee exactly-once external side effects.

Urgent notices are task-scoped. No unsolicited captain prompt may create an
unrelated Slack reply. Late messages remain available for explicit retrieval.
Crew text and final session replies are never sent straight to Slack.

`greybeard:` one active job and a bounded FIFO per configured member, no
autonomous captain wakeups. Global scheduling or unsolicited Slack continuation
needs an explicit correlated delivery design, not a transcript heuristic.

State is private, durable local data. Do not delete it to clear errors or
automatically replay interrupted tool work. Compaction preserves stored
history but is lossy context summarisation, not a backup. Crew histories and
Mesij's shared project log are not confidential per-thread stores.

Agent rules and tool ownership checks are not OS isolation. Trusted coding
agents with shell access can bypass a cooperative session-creation rule. Use
separate OS identities/containers if that must become a security boundary.
Human viewing is supported through OpenCode's session selector or
`opencode mini --session SESSION_ID`; do not type into a session while Pogo or
its crew owns an active task. Never use `--standalone` to find these sessions.

[compaction]: https://opencode.ai/v2/docs/compaction
