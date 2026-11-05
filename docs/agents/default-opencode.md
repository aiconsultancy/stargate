# Default OpenCode captain/crew profile

Pogo's default **opt-in OpenCode agent profile** uses CLIProxyAPI and a
Slack-facing captain, Bowser. It is not a change to the gateway's fail-closed
permission defaults. Use this profile only for trusted Slack users: the coding
crew can edit files and run commands under the OpenCode service's OS account.

## Roles

| Primary agent | Role                                                                       | Lifetime                                   |
| ------------- | -------------------------------------------------------------------------- | ------------------------------------------ |
| Bowser        | Answer simple questions; coordinate substantial work; return Slack replies | One existing Pogo session per Slack thread |
| Mario         | Backend and general implementation                                         | One durable session per bot                |
| Luigi         | Frontend and integration implementation                                    | One durable session per bot                |
| Daisy         | Read-only documentation and Linear research                                | One durable session per bot                |
| Toad          | Verification and review                                                    | One durable session per bot                |

The four crew sessions are root OpenCode sessions, not temporary children of a
Slack thread. Bowser creates them lazily through the V2 API and reuses them.
There are at most four for the bot, across all its threads. Each crew member
has a named worktree and manages feature branches there. Never work on or
commit to `main` or `master`. The captain workspace stores coordination state,
not another implementation checkout.

Crew may use temporary model-named child agents, but must consult the global
[`agent-profiles` routing skill](agent-profiles.md) before selecting one.
The default global child profiles also use CLIProxyAPI, not direct-provider
fallbacks. Global profile switches do not change a crew session's stored model.
They must never create additional root sessions. Daisy's session-scoped
read-only permissions also constrain her children. Her Linear tools permit
information gathering, not issue/comment/status changes. A fresh machine may
need its own Linear sign-in; local files do not transfer that connection.
Daisy's generated config uses Linear's `/mcp/readonly` endpoint and requests
only the `read` OAuth scope. Its tools are direct, so Daisy and her children
do not need shell or arbitrary Code Mode access. In Daisy's OpenCode worktree,
run `/mcps`, select `linear`, and complete the operator sign-in. Configuration
alone is not a verified connection; check its status and one read-only call.

## Fresh-machine setup

1. Check out Pogo and the target project. Install mise and OpenCode V2.
2. Run `mise install` and `make deps`. This includes the pinned Mesij CLI.
3. Follow [CLIProxyAPI bootstrap](../cliproxyapi.md). Provider subscription
   sign-in and private credentials are separate from Slack authentication.
4. Have the setup model follow the [global agent-profile gist](agent-profiles.md).
   Review its discovered mappings and approve required migrations first.
5. Create the captain/crew configuration and four worktrees:

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
   Register only **Bowser**, not the crew, with Pogo. Set its backend directory
   to the captain workspace and agent to `bowser`.
7. For this trusted profile, set `backend.permissions` to Bowser's generated
   `agents.bowser.permissions` rules. A session-level deny-all overrides agent
   allows; leaving that gateway default in place intentionally blocks tools.
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

## Coordination and limits

Mesij stores ordinary crew messages. Stable bot-scoped identities, inbox
cursors, worker session IDs, and task ownership belong to the crew integration.
Only Bowser's originating task receives its result. Do not route by the last
captain to use a worker. Only one assignment can be active per crew member;
busy members are reused after completion, not replaced by additional sessions.

Urgent notices are task-scoped. No unsolicited captain prompt may create an
unrelated Slack reply. Late messages remain available for explicit retrieval.
Crew text and final session replies are never sent straight to Slack.

`greybeard:` one active job per member, four fixed slots, no autonomous captain
wakeups. Broader queued scheduling or unsolicited Slack continuation needs an
explicit correlated delivery design, not a transcript heuristic.

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
