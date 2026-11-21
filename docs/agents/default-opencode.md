# OpenCode captain/crew profiles

Stargate's **opt-in OpenCode agent profile** uses CLIProxyAPI and a Slack-facing
captain. New ships require an explicit `--team`, including a Pi helper. It does not change
the gateway's fail-closed permission defaults. Use this profile only for
trusted Slack users: the coding
crew can edit files and run commands under the OpenCode service's OS account.

## Starter roles

| Primary agent | Role                                                                       | Lifetime                                   |
| ------------- | -------------------------------------------------------------------------- | ------------------------------------------ |
| Bowser        | Answer simple questions; coordinate substantial work; return Slack replies | One durable session per configured captain |
| Mario         | Backend and general implementation                                         | One durable session per bot                |
| Luigi         | Frontend and integration implementation                                    | One durable session per bot                |
| Daisy         | Documentation/Linear research; assigned ticket updates and comments        | One durable session per bot                |
| Toad          | Verification and review                                                    | One durable session per bot                |

Crew sessions are root OpenCode sessions, not temporary children of a Slack
thread. The captain creates them lazily through the V2 API and reuses them.
The captain also has one durable session. DMs, channels, threads and scheduled
work select reply destinations, not new captain identities. Captain memory is
shared across these sources; use separate teams for separate trust boundaries.
There is one per configured member, across all the team's threads. Each member
has a named worktree and manages feature branches there. Never work on or
commit to `main` or `master`. The captain workspace stores coordination state,
not another implementation checkout.

Crew may use temporary model-named child agents, but must consult the global
[`agent-profiles` routing skill](agent-profiles.md) before selecting one.
The default global child profiles also use CLIProxyAPI, not direct-provider
fallbacks. Global profile switches do not change a crew session's stored model.
They must never create additional root sessions. All trusted profiles permit
broad shell, file edits, browser and Code Mode access; specialisms guide
assignments rather than restricting these tools. Task authority and privacy
rules also apply to child agents. All crew roles
may use Linear read/write tools for their assigned tasks, including ticket
updates and comments. This is not permission for unrelated changes or
workspace administration. Follow the target project's delivery rules.

## Pull request scope

A new ship's default `WAYS_OF_WORKING.md` gives captains and crew a shared
delivery rule. Group related low-risk changes with their tests and docs when
the project permits it and reviewers can verify them together. Lead with a
complete, testable user-visible change where practical. Split when risk, rollback, reviewability or independent
delivery justifies another build, review and merge cycle. Repository rules
govern each PR. Report implementation, compilation, cache waits, tests,
reviews and approvals separately in the delivery record. Fleet rear admirals
consider the same trade-offs when advising captains.

The initializer preserves an existing ship's agreement. Its captain or operator
can add the [PR scope section](../../templates/ways-of-working.md#pull-request-scope)
to that file separately. Captains and crew are instructed to reread the
agreement when it changes.

## Generated prompt boundaries

Generated captain and OpenCode crew definitions keep YAML frontmatter first.
Their prompt bodies use one pair of valid HTML comments:

```markdown
<!-- STARGATE:START -->

Stargate-generated role and ship instructions.
<!-- STARGATE:END -->
```

Generated Pi worker definitions use the same markers, without frontmatter.
The marker strings are reserved; configured instructions cannot contain them.
Operator notes belong outside the marked body. Markers identify generated text;
they do not authorize automatic replacement. Initialization still refuses
conflicting OpenCode definitions and preserves existing Pi definitions.
Existing customized or unmarked files need an explicit, backed-up migration;
initialization does not infer their boundaries or rewrite them.

Project `AGENTS.md`, the captain-maintained `WAYS_OF_WORKING.md`, ship logs and
journals remain unchanged. If Stargate instructions are added to a shared file in
an approved migration, mark only that section and preserve all surrounding text.

## Configured teams

Captains can persist a waiting-response delay with `stargate_waiting` when a user
asks to change it. This uses the existing `stargate_crew` permission and verifies
the caller's real captain session. See [waiting responses](../waiting.md) for
defaults, off versus zero, workspace persistence and plugin activation.

Native OpenCode crew clarifications can route automatically to the task's
originating captain when that captain enables
[`/config questions on`](../meta-commands.md#opencode-clarification-questions).
The crew plugin reads the same private settings using the captain's native
agent identity and workspace. It does not post crew questions to Slack.
Pending forms are reconciled from active tasks, including after a restart.

The captain receives numbered choices and an exact token through the existing
crew DM path. Use `stargate_question` with `op: "answer"`, that `token`, and
`answer` containing a choice number, comma-separated choices, or JSON native
field values. Use `op: "cancel"` with the token to cancel the form. Include
the notice's `project` for a non-default project. The existing `stargate_crew`
permission applies; only the exact originating captain can answer while the
same worker task, input and form remain active. This is not a tool-permission
approval. No crew ownership, queue or controller is changed.

An expired offer makes one native cancellation attempt. A failed or interrupted
native write remains uncertain and cannot be replayed through its token.
Unsupported or sensitive forms stay in the native operator interface.

Captains can post as their own bot to another allowed Slack channel or
thread with `stargate_post`, instead of asking an operator to relay. It uses the
`stargate_crew` permission and the captain's `cron` gateway binding, and is off
until the bot sets `captainPost`. Crew cannot use it. See
[captain posts](../captain-post.md).

The bound root Slack captain can use `stargate_notifications` to mute its own
registration's threads or channels. The tool uses the existing `cron` binding
and normal tool permissions; it does not grant new global permissions. See
[notification muting](../notifications.md) for targets, wakes and limits.

Copy [`team.example.json`](../../team.example.json), a portable Galactica team
with captain `adama`, four OpenCode workers and a tools-off Pi helper, `twiki`.
Choose ship-specific names and verify the helper's provider endpoint, model and
credential reference before provisioning. The example is not a ready worker:
`STARGATE_PI_HELPER_API_KEY` must be supplied securely in the OpenCode plugin
host's environment. Setup does not read another ship's credentials, configure
a provider, or select a paid/native fallback.

```sh
stargate crew init --team team.example.json --id galactica \
  --directory /srv/stargate/galactica/captain --project /srv/project \
  --worktrees /srv/stargate/galactica/crew --base origin/main
```

See [ship maintenance](../ship-maintenance.md) for durable captain/crew journals,
the shared ship log, project-owned skill learning and an optional nightly
inspection through the existing `/cron` form. No schedule is enabled by default.

Team JSON contains `captain: { id, agent?, name?, model?, instructions? }` and a
nonempty `crew` array. Each worker has the same identity fields plus `role`
and `permissionProfile` (`coding` or `research`). IDs use lowercase letters,
digits, `_` and `-`, at most 64 characters. IDs must be unique and distinct
from the captain. `captain` and `all` are reserved crew-message aliases.
Stargate IDs remain short addresses such as `adama` and `apollo`. Optional `agent`
maps an address to its native OpenCode definition. Generated profiles set native
IDs and filenames to `<namespace>-captain-<name>.md` or
`<namespace>-crew-<name>.md`, for example `galactica-crew-apollo.md` and
`pegasus-crew-apollo.md`. Communications do not need these full native IDs.
Names/instructions are non-secret text, not credentials. Unknown fields fail.
Agent IDs must match their assigned names, normalized to lowercase with word
separators as hyphens. Hidden legacy aliases are rejected: Chief is `chief`,
not `mario`; Adama is `adama`, not `bowser`. Existing mismatched installations
need an explicit backed-up identity migration; never delete session history.
Optional `historyScope` is `team` (default), `project`, or `server`. Captain and
crew use `stargate_history` to search OpenCode history through the API. Server scope
includes all sessions on that OpenCode server, including other namespaces.
Optional `toolAccess: "direct"` lets this trusted team use all registered tools
and connectors without maintaining a per-tool list. Omit it for the existing
curated grants. Both modes retain secret-file read exclusions. Specialisms
guide task assignment; they do not forbid direct implementation or diagnosis.
See [autonomy](../autonomy.md) and [session history](../session-history.md).
Project
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
environment, not just Stargate's shell. Never put header values in team JSON.
Without a verified endpoint, history is unavailable; there is no DB fallback.

Permissions follow the explicit profile, never a name. Models use
`provider/model#variant` (variant optional) and become `agents[nativeID].model`.
Omitted models use the existing template default. The engine selects configured
worker models when creating sessions; existing sessions keep stored models.
Optional `modelProviders` bounds model-tool discovery/switches. It defaults to
`["openai-proxy", "claude-proxy", "go-proxy"]`; there is no silent fallback to
another provider. The example records this allowlist explicitly.
For the gateway captain session, select `backend.agent` and, when needed,
`backend.model` explicitly; changing agents does not replace a stored model.

## One captain session

Bind one existing native root session before starting the captain gateway.
Set its ID in two places:

- Gateway registration: OpenCode `backend.sessionID`.
- Every team location's Stargate plugin options: `captainSessionID`.

The IDs must match. For example, the gateway backend can contain:

```json
{
  "type": "opencode",
  "url": "http://127.0.0.1:4096",
  "directory": "/srv/stargate/galactica/captain",
  "agent": "galactica-captain-adama",
  "sessionID": "ses_existingCaptain"
}
```

This fragment omits permissions. Keep the trusted profile's explicit rules.
A pinned session keeps its stored model and permissions; binding does not
replace them. Stargate validates the session ID, root identity, agent and directory.
Missing or incompatible sessions fail instead of creating replacement roots.
Use the same session in OpenCode's native interfaces.

For a fresh installation, generate the profiles first, then select or create
one root session with the configured captain agent and directory. Creating a
native session does not start a model turn. Record its ID and set both pins.
For a profile generated around an existing session, `crew init --session-id`
puts the plugin pin in each generated location and returns `sessionID` for the
gateway. `bot add --session-id` sets the gateway pin. Existing conflicting
profile files are not overwritten; update existing pins explicitly.

Only one bot registration and one gateway process may own that pinned session.
Stargate rejects duplicate pins within one configuration. Separate processes cannot
detect each other's pins, so cross-process sharing is unsupported.

When migrating, retain the original captain and archive duplicate roots only
after confirming they are idle. Keep their history and raw task ownership IDs.
The canonical captain can collect legacy tasks and receives new captain-alias
messages. Old Mesij messages already addressed to duplicate roots remain in
those mailboxes; they are not copied into the canonical inbox.
A previously unconfirmed captain-bound send retried after binding can store
a second copy for the canonical recipient because its destination key changes.
Check its retained receipt before retrying.

OpenCode's plugin API has no session-create hook. An operator can still create
another native root manually, but the pinned crew plugin refuses it captain
authority. Stargate neither creates nor wakes replacement captain roots.

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
stargate crew init --team galactica.json --id galactica \
  --directory /srv/stargate/galactica/captain --project /srv/project \
  --worktrees /srv/stargate/galactica/crew --base origin/main
stargate crew init --team pegasus.json --id pegasus \
  --directory /srv/stargate/pegasus/captain --project /srv/project \
  --worktrees /srv/stargate/pegasus/crew --base origin/main
```

Set both registrations' `backend.url` to that service, but use their own
generated directory, captain agent and permission rules, and distinct Slack
app registrations. State stays under each captain's `.local/stargate-crew`.

Do not silently rebind persisted identities to another roster, path or captain.
Existing roster IDs/directories remain fixed once persisted, including legacy
starter states. Keep existing state and sessions. New members can use the
explicit append-only `allowCrewExpansion` rollout described below without a
new namespace. Other roster changes require an explicit migration. Model
changes use the explicit session-switch operation below. Setup refuses
conflicting overlays; it does not overwrite an existing starter installation.
Existing sessions also keep their stored permission rules. New agent defaults
do not grant history/model tools to old sessions; update session permissions
only during an operator-approved rollout.

## Pi Durable crew

A new ship's `crew init` requires at least one Pi member with an explicit
`backend.model` and `backend.provider` (`baseURL` and `apiKeyEnv`). Missing
configuration fails before setup writes files or creates worktrees. The
runtime's legacy Bowser starter roster and existing team schemas stay unchanged;
this setup rule does not append members to an implicit existing roster. Existing
profiles use the approved append-only procedure below, not `crew init` to
overwrite their overlays.

The standard helper starts with `tools: "none"` for captain-supplied reports.
The captain supplies status, results and journal excerpts in the assignment;
the helper cannot inspect crew state or use Mesij itself. Add host coding tools
only through an explicit approved opt-in. A role or `permissionProfile` does not
enable Pi tools. No schedule, extra Slack app or IRC account is created.
Verify proxy model availability and the credential reference's presence in the
actual plugin host before `ensure`; a generated profile is not proof of durable
session readiness or a successful model request.

A crew member can opt into Pi Durable with `backend`. Other members remain
OpenCode workers. For a separately approved coding-enabled helper, add this
member to the team's `crew` array (not the default tools-off pattern):

```json
{
  "id": "twiki",
  "name": "Twiki",
  "role": "Bounded cleanup and maintenance tasks",
  "permissionProfile": "coding",
  "instructions": "Preserve unrelated work. Propose destructive cleanup before execution; require explicit operator approval from the captain.",
  "backend": {
    "type": "pi-durable",
    "model": "openai/opencode-go/deepseek-v4.1-flash",
    "provider": {
      "baseURL": "http://127.0.0.1:8317/v1",
      "apiKeyEnv": "CLIPROXYAPI_API_KEY"
    },
    "systemPrompt": "Perform only the captain's assigned maintenance task. Return changed files, checks and blockers. Never communicate directly with Slack.",
    "tools": "coding"
  }
}
```

Do not set the member's OpenCode `model` field as well. `backend.model` selects
the Pi model; `backend.directory` is not accepted because the crew worktree
supplies it. The proxy must publish `opencode-go/deepseek-v4.1-flash`.
For Claude, use `"model": "anthropic/claude-haiku-5-5"` with the same
`provider` and `"thinkingLevel": "low"`; the proxy must publish
`claude-haiku-5-5`. Pi model IDs take no `#variant` suffix. Without
`thinkingLevel`, Pi's default `off` disables Haiku thinking. Set the level
before `stargate_crew ensure`: an existing worker conversation keeps its level.
The key variable must exist in the **OpenCode plugin host's** environment,
not only the Slack gateway's environment. No paid/native route is substituted.

Profile initialization creates Twiki's feature worktree and a private definition
at `<captainDirectory>/.local/ship/definitions/<native ID>.md`, not an OpenCode
agent overlay. The Pi backend consumes that trusted definition when it opens;
initialization preserves captain edits. Native request hooks advise a reread of
the shared working agreement only after its content changes, without injecting
the file contents. `stargate_crew ensure` creates one private Pi conversation, reused
across assignments and host restarts. Pi storage lives under the team's private
state directory, separate from OpenCode sessions. Its peer ID is a Stargate handle,
not an OpenCode session that can be opened with `opencode mini`.

The captain uses the existing `dispatch`, `wait`, `status`, and `queue: true`
operations. Final Pi text completes the assigned task automatically; Twiki does
not call `stargate_crew complete`. Only the originating captain can collect it.
There is no extra Slack registration. Coding-enabled Pi members support Mesij
mail, explicit DM and milestone journals through host-bound native tools. Only
explicit DM can wake a captain. Self-only `pi_history` reads the current native
conversation; unified OpenCode history, compaction and model switching remain
unsupported. Assigned work stops after five minutes or 50 turns.

An interrupted or failed Pi task becomes `uncertain`; it blocks the worker
instead of resubmitting maintenance automatically. A saved completed Pi receipt
can recover the exact result after restart without new model work. Otherwise
the captain can inspect, preserve changes and explicitly abandon the task through
[crew recovery controls](../crew-recovery.md#captain-controlled-recovery).
Unconfirmed conversation creation is not repeated. Never delete state to clear
a reservation. Plugin shutdown cancels and closes Pi work.

For an existing roster, an approved append-only rollout may set
`allowCrewExpansion: true` in **each generated Stargate plugin's options**. Supply
the same updated team and add each new member's path to `worktrees`. This accepts
new OpenCode or Pi members, preserving every existing worker's ID, permission profile,
directory, session, tasks and results. It rejects removal or rebinding. Clear
the flag after rollout. Back up private state first and update at an idle
boundary; the profile initializer still refuses conflicting overlays.

### Expansion rollout steps and its failure signature

Without the flag, a changed roster fails inside OpenCode plugin setup, which
OpenCode swallows silently: nothing is logged, and the captain's turns lose
every `stargate_*` tool. A captain answering "stargate_crew is not available
in this turn" after a roster edit has hit this guard; restore the original
options or complete the flagged rollout. The state database pins the roster
fingerprint, and the flag only accepts pure additions: same namespace,
project directory and captain, and every existing member unchanged.

A complete OpenCode-member rollout:

1. Add the roster entry with an explicit `agent` id
   (`<namespace>-crew-<id>`); ids are kebab-cased names. Add the worktree
   path to the options `worktrees` map, which must exactly match the crew
   ids. Keep the team source document in sync.
2. Create the member worktree from the project checkout and copy a coding
   member's profile: set the member's model in the profile's `model`,
   `default_agent` and `agents` entry, and write the agent markdown from
   the crew template with the member's identity, role and worktree. A Pi
   member needs no profile.
3. Sync `team`, `worktrees` and the flag into **every** plugin options copy
   (the captain's and each OpenCode member's own profile embed the same
   options). Options load only at server start: restart the OpenCode server
   at an idle boundary; in-flight sessions are interrupted.
4. Verify with the captain: `stargate_crew` op `roster` must list the new
   members and the tool must work again. Provision the new sessions through
   the captain's in-session `stargate_crew`; direct shell `opencode api`
   RPC calls fail the captain-location check by design. Finish with a
   bounded read-only onboarding task per new member.

`tools` defaults to `none`. `coding` grants trusted read/write/edit/bash in the
host OS account; a worktree is **not a sandbox**, and there is no Slack tool
approval UI. Approval instructions are cooperative, not enforced isolation.
Do not grant coding tools to untrusted tasks. A Pi worker's explicit `tools`
setting, not its specialism, controls host-tool access. Tools-none recipients
return unsupported without storing unreadable mail. Report contexts keep their
selected tools-off extension list and restart guard.

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

1. Check out Stargate and the target project. Install mise and OpenCode V2.
2. Run `mise install` and `make deps`. This includes the pinned Mesij CLI.
3. Follow [CLIProxyAPI bootstrap](../cliproxyapi.md). Provider subscription
   sign-in and private credentials are separate from Slack authentication.
4. Have the setup model follow the [global agent-profile gist](agent-profiles.md).
   Review its discovered mappings and approve required migrations first.
5. Create the starter configuration and worktrees (or use `--team` above):

```sh
make crew-init ARGS='--directory /srv/stargate/bowser --project /srv/projects/example --worktrees /srv/stargate/example-crew --id bowser --base origin/main'
```

The captain and crew directories must not be nested inside each other's
OpenCode configuration tree. The source checkout is not switched, reset, or
cleaned. New branches start at the explicitly selected committed ref. Fetch
that ref first when current upstream code is required. Existing worktrees are
reused only for the same Git project on a non-main branch. Local Git excludes
keep generated overlays and persona files out of project commits.

Use `--workspace-mode clone` for independent assigned checkouts instead. The
`--worktrees` path remains the parent directory, but this mode uses `git clone
--no-hardlinks` and creates no Git worktrees. Each clone retains its own Git
metadata and the source repository's upstream URL. Existing clones must match
that upstream and use a non-main feature branch. An assigned checkout is an
operating rule; it does not prevent a process from reading other checkouts.

The command refuses conflicting files; it never replaces custom instructions
or tracked project config. If `.agents/opco` exists, it uses that canonical
directory and requires `.opencode` to be its compatibility symlink. Otherwise
it uses `.opencode/agents/` and `.opencode/opencode.json`.

The default provider key reference is `{env:CLIPROXYAPI_API_KEY}`. That variable
must exist in the **OpenCode service's** environment, not merely Stargate's shell.
Alternatively, reference an existing private key file without exposing it:

```sh
make crew-init ARGS='--directory /srv/stargate/bowser --project /srv/projects/example --worktrees /srv/stargate/example-crew --proxy-key-file /srv/private/proxy-client.key'
```

Never pass a token value in `ARGS`. This command does not install/start a
service, create Slack apps, start model work, or change global authentication.
OpenCode reloads local configuration after a save.

6. Use [batch Slack provisioning](../setup.md) to create or reuse bot apps.
   Register only the captain, not workers, with Stargate. Use the setup output's
   `directory` and `agent` for `backend.directory` and `backend.agent`
   (`bowser-captain-bowser` for the starter,
   `galactica-captain-adama` for the example).
7. For this trusted profile, copy the output's `permissions` array to
   `backend.permissions` (also in `agents[<native captain ID>].permissions`).
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

The captain can read its current session model with
`stargate_model({ "op": "get" })`. This uses the existing authenticated session
connection and returns `sessionID` and `model: { providerID, id, variant }`.
An absent variant returns `default/unspecified`, not an inferred reasoning level.
If the session has no selected model, the tool reports an error instead of
guessing. This operation supports the caller's configured captain or assigned worker session. It does
not query the model catalog, create sessions, change models, or restart anything.
Existing sessions need permission for the `stargate_model` operation `get`.

Captains can inspect an existing own-roster worker with
`stargate_model({"op":"inspect","target":"starbuck"})` without waking it or
creating a session. To set only that worker's effort, use
`stargate_model({"op":"effort","target":"starbuck","variant":"high"})`.
Pass `project` with the exact configured project key for another project owned
by this captain. Foreign captain roots, unknown crew/projects and worker callers
are refused. The tool reads the worker's actual selected provider/model and
validates the requested variant in that project's live enabled catalogue.
It never changes provider/model, recreates a session, compacts, interrupts or
forces active, uncertain or held work. Even an already-selected variant requires
the same idle/control guard; use read-only `inspect` while the worker is busy.
Refused effort requests are not queued or retained. Existing task state remains
unchanged; an effort change needs a new explicit request after the worker is idle.
A missing selected model and a selected provider outside the team's allowlist
have distinct errors, without a guessed model or fallback. Read `inspect` after an unconfirmed
SDK outcome before deciding what to do next. No fallback is applied.

Native permissions must cover each tool operation. The generic trusted captain
profile intentionally grants `stargate_model` on `*`; this existing wildcard
already includes `inspect` and `effort`, as well as legacy `switch`. This feature
does not narrow that public profile or rewrite existing session rules.
Restricted profiles may instead grant explicit `list`, `inspect` and `effort`
resources without allowing generic `switch`. Such explicit rules need their
operator's reviewed commissioning/adoption procedure; an upgrade does not add
missing explicit grants. Keep the actual task IDs, native session IDs and model evidence;
never relabel old work or infer HIGH from a default/unspecified variant.
Changes affect subsequent provider turns; they make no claim about prior work.

The captain can discover models and switch its own or a worker's session model
with `stargate_model`. Load `agent-profiles` before selecting a route. Optional
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

Use `stargate_history` with `{"op":"search","query":"authentication migration"}`
to find prior user/assistant text. Follow its returned cursor while `partial`
is true. Searches are bounded API scans, not a semantic index. They omit
reasoning, system prompts and raw tool output, and return historical text as
untrusted data. Compaction does not remove the stored transcript.

## Coordination and limits

Use the [crew coordination guide](../crew-coordination.md) for the read-only
roster, append-only SQLite journal, asynchronous mail and explicit native DM.
Coding-enabled Pi crew share these handlers; tools-none crew remain tools-off.
Mail and journal notes never wake agents. Explicit DM can wake the originating
captain and free colleagues; another captain's busy work receives stored mail
without steering. No final answer substitutes for a correlated peer reply.
When an assigned worker has become idle, a late DM stays in its durable inbox
without appending native input. This leaves the exact retained task answer
recoverable through `status` or `wait`. Idle is not proof of success: those
operations still verify the original task turn. Active workers retain DM steer;
an occupied task does not become a free-worker wake if collection races delivery.
Child agents use their own standard tools, never Stargate tools or prefixed names,
and do not start children. Crew reply on IRC only when tagged, asked directly,
or once per all-call.
New tools reuse existing permission actions (`stargate_journal`: `stargate_crew`,
`stargate_dm`: `stargate_mail`), without replacing stored session permissions.

Captain maintains `<captainDirectory>/WAYS_OF_WORKING.md`. Initialization only
creates it if absent. All definitions and Pi member instructions reference this
same path and advise an initial read and a reread when updated. Contents are not
repeatedly injected. Existing Markdown journals remain history; new milestones,
checks, blockers, outcomes and useful native-workaround feedback go through
`stargate_journal`. Working agreements never grant extra authority.

Install namespaced native definitions and explicit `agent` mappings together.
An operator can switch existing native sessions to those definitions without
resetting Stargate member IDs or deleting history. Backend agent settings select
the captain's native ID. Existing physical worktree paths can remain. This
feature does not perform automatic live session migration or service changes.

Mesij stores ordinary crew messages. Stable bot-scoped identities, inbox
cursors, worker session IDs, and task ownership belong to the crew integration.
Only the originating captain's task receives its result. Do not route by the
last captain to use a worker. Only one assignment can be active per crew member;
busy members are reused after completion, not replaced by additional sessions.

The captain uses role and prior task/history evidence for assignment affinity;
there is no automatic semantic matcher. For urgent work prefer a suitable idle
member over waiting for an experienced busy member. If all suitable members
are busy, `dispatch` with `queue: true` explicitly opts into a bounded durable
queue per member, up to 100 queued tasks. Without that flag, busy dispatch
returns `busy` and is not queued. FIFO is the default instruction, not a runtime
lock. The captain can select another queued task with `status` or `wait`, or
dispatch priority work when the worker is idle. Unselected tasks stay queued.
Read-only checks and direct-message roll calls can pass queued assignments.
Active/uncertain work, task ownership and controller guards still apply. There is no
background scheduler: a queue left without polling stays pending.

### Persistent sessions and tasks

OpenCode stores session transcripts and selected models. Stargate's separate crew
SQLite database stores the configured member-to-session registry, task IDs,
originating captain session IDs, status, results, notices and mail cursors.
Queued tasks also retain their input text. Stargate's gateway database separately
tracks Slack requests and reply delivery; these are not interchangeable stores.

1. `ensure` reserves a stable session ID before calling OpenCode. An uncertain
   create is inspected using that ID, not retried with a new identity. Missing
   previously confirmed sessions require recovery, not automatic replacement.
2. `dispatch` reserves one active task per worker in a SQLite transaction,
   then submits a uniquely identified input to that worker's existing session.
   An explicit queued assignment remains unsubmitted until promoted.
3. A successful final worker answer completes the task when the captain checks
   `status`, `wait`, or the next `dispatch`. Stargate verifies the existing session,
   task boundary and native outcome before recovering its visible answer. The
   worker may also call `complete` explicitly. Only the originating captain
   session can collect that task's result through the crew tool. See
   [automatic result recovery](../crew-recovery.md).
4. A completed slot is reused only after OpenCode confirms the worker is idle.
   Results remain stored after reuse. Queued jobs keep FIFO order per member.
5. Ambiguous admission, interrupted execution or unavailable result evidence
   can leave a task `uncertain`. It blocks slot reuse and is never automatically
   replayed. A later verified final answer can recover the same task.
   A captain can also explicitly abandon the exact task after inspecting its
   evidence and workspace. This keeps the audit, history, results and queue;
   native stop remains separately confirmed or unconfirmed.
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
`opencode mini --session SESSION_ID`; do not type into a session while Stargate or
its crew owns an active task. Never use `--standalone` to find these sessions.

[compaction]: https://opencode.ai/v2/docs/compaction

### Resume a retained OpenCode task

Resume is off by default. Set `exclusiveWorkerInput: true` in the crew
plugin options or `STARGATE_CREW_EXCLUSIVE_INPUT=1` in the OpenCode service
environment only for a protected deployment where Stargate owns worker
input. Restrict native API access and credentials to the service and its
trusted operator, and coordinate any operator writes outside the resume
window. The environment setting applies to every crew project inside that
OpenCode process. A flag alone does not restrict native OpenCode clients. Use a
separate managed worker session from any interactive OpenCode session.

If status reports an owned task as `uncertain` and the worker is idle, inspect
that exact task with `stargate_crew`. Use `op: "resume"` with its `taskID` and
an `expected` object containing `workerSessionID`, `originCaptainID`, `inputID`
and the inspected `execution.time.idle` as `idleAt`. Keep the project selector
when the task belongs to another configured workspace.

Stargate checks the worker and original assignment, refuses pending native work
or a later unrelated input, and reports any retained final answer for collection.
Otherwise it records one attempt for that idle boundary and sends a continuation
to the original session. The worker reads task mail and resumes from its saved
progress. Use `status` on the same task to observe the run or collect the result.
If admission is uncertain, inspect the existing session before taking another
action. An exact retry for the same idle boundary uses the same native message
ID, which OpenCode admits once. Stargate queues the continuation so it cannot
steer an active turn.
This operation applies to OpenCode crew tasks.

### Crew questions with a read-only history service

The IRC gateway enables `features.crewQuestionHandoff` by default on a pinned
OpenCode registration. A matching crew plugin uses it after it receives polls
for the pinned captain at its configured location. Unpinned plugins use their
existing direct route. Pinned Slack, Teams and standalone captains using
native service discovery also use direct access when no gateway is polling.
The worker can start that direct path before the captain's plugin location
loads. This also lets a newer plugin work while an older gateway has handoff
disabled.

Set `features.crewQuestionHandoff: false` to stop the IRC gateway polling.
On a pinned crew with `team.historyAPI` configured, the plugin waits for
the gateway before accessing native forms. This lets the history endpoint
stay read-only through startup and reconnects. Set `team.questionGateway:
false` to always use direct access with a form-capable endpoint. Set
`team.questionGateway: true` to require gateway handoff.
If a crew assignment is active and its saved settings enable questions while
the gateway is unavailable, the plugin logs the waiting route and the direct
opt-out once per plugin location.
Once the owning gateway is polling, crew questions default on when the
captain's per-agent question settings file is absent. An existing
`enabled: false` disables them. Invalid and unreadable settings also keep
them disabled. Standalone direct access keeps its existing per-agent setting.
The captain receives the task DM and answers with the existing
`stargate_question` tool. Project, assignment, worker input and captain
session stay the same.

The gateway takes commands from the plugin at its configured captain location.
It verifies the worker's native session and running question, then checks the
task with the plugin immediately before submitting an answer. The crew plugin
keeps the durable answer claim. Each attempt uses one route, and a lost
acknowledgement leaves the claim spent.
The gateway checks the form for its native outcome when it reconnects. If the
form is still pending, inspect it in OpenCode. The history service needs only
its existing read permissions.

Run the disposable integration fixture with a locally installed OpenCode 2.2.7
binary and the pinned Mesij binary. It uses the installed crew plugin, SQLite,
a local deterministic model and the 2.3.2 SDK. Optionally pass the read-only
history broker script as the third argument. Add `--lose-ack` after the broker
path to exercise gateway restart during answer delivery.
Add `--standalone` instead of a broker path to exercise the native discovery
route with a pinned captain and no gateway.

```sh
mise exec -- bun scripts/crew-question-smoke.ts /path/to/opencode "$(mise which mesij)"
```
