# Slack agent feature comparison

Comparison date: 2026-11-06. This is a product capability comparison, not a
claim that Stargate has the same security model or deployment architecture.

## Products compared

- [Claude Code in Slack](https://code.claude.com/docs/en/slack) starts coding
  sessions under an individual account. Its documented controls include
  repository selection, progress, **View session**, and **Create PR**.
  This earlier integration is distinct from the organization-managed
  [Claude Tag](https://claude.com/docs/claude-tag/overview).
- [ChatGPT in Slack](https://developers.openai.com/codex/third-party/slack)
  can delegate repository work to Codex Cloud when the deployment supports
  it. Its documented controls include private approvals, **Follow along**,
  and requester cancellation. The documentation directs former `@Codex`
  users to start new requests with `@ChatGPT`.
- A Slack connection used to search Slack _from ChatGPT_ is the opposite
  direction. It does not establish feature parity for a bot invoked in Slack.

Vendor features depend on plan, workspace configuration, and account access.
The linked documentation can change after this comparison.

## Capability gaps

| Capability                    | Vendor evidence                                                              | Stargate status                                                                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Start work from a mention     | Both coding integrations                                                     | Supported, with explicit user/channel access rules.                                                                                                          |
| Continue a thread             | Both coding integrations                                                     | Ordinary bots use durable per-thread sessions; captains use one pinned session across sources, with source-specific reply delivery.                          |
| Direct messages               | General ChatGPT/Claude offerings differ; earlier Claude Code is channel-only | Supported for allowed DMs.                                                                                                                                   |
| Visible progress              | Claude Code progress; ChatGPT task-start messages                            | Streaming replies and named waiting feedback.                                                                                                                |
| Scheduled prompts             | Claude Tag                                                                   | Supported through `/cron`; not evidence of every vendor's scheduling behavior.                                                                               |
| Current model inspection      | Not established by these vendor pages                                        | `stargate_model` can read the current captain session, including its stored variant.                                                                         |
| Requester cancellation        | ChatGPT documents requester task controls                                    | Supported through a requester-only Stop button on live previews; see [limits](cancellation.md).                                                              |
| Initial Slack context         | Claude Code documents gathering invocation context                           | Opt-in initial thread context imports bounded requester/bot text. No automatic channel context or other participants' text; see [limits](thread-context.md). |
| Open the task/session         | Claude Code **View session**; ChatGPT **Follow along**                       | Gap: no backend-neutral task link in Slack.                                                                                                                  |
| Repository/environment choice | Claude repository picker; ChatGPT accessible Cloud environments              | Gap: backend directory is configured per bot, not selected in Slack.                                                                                         |
| Approval cards                | ChatGPT private **Allow**/**Deny**                                           | Gap: no Slack approval bridge for backend permissions. Deny-by-default remains required.                                                                     |
| Create-PR control             | Claude Code **Create PR**                                                    | Gap in native UI. An authorized agent may use GitHub tools; that is not a Stargate PR button.                                                                |
| Per-user repository identity  | Claude individual accounts; ChatGPT account/environment access               | Architectural gap: Stargate uses a shared configured backend, not each Slack user's repository credentials.                                                  |
| Files/artifact transport      | Not established by the compared coding pages                                 | Supported for backends on the same host: images and files in both directions; see [attachments](attachments.md). Do not claim vendor equivalence.            |

## Incremental delivery order

1. Current-model reads: completed. Read the authenticated session, not an
   agent default or a guessed reasoning level. Missing variant is
   `default/unspecified`.
2. Requester cancellation: implemented with a durable job and requester binding.
   Preserve bot/workspace/channel checks and stop the underlying work.
   Cancellation does not roll back external effects or guarantee termination
   of an external system that does not honor interruption.
3. Explicit context import: implemented as an opt-in initial thread read.
   Limits: one page of 50 fetched messages, 20 imported messages, and 12,000
   text codepoints. Only the requester and this bot are included. Imported
   text is untrusted reference data. The current Slack method contract lists
   bot-token history scopes; membership and API errors still apply. This does
   not import channel history or establish per-user repository isolation.
4. Device pairing: `/stargate pair` can privately issue standard OpenCode pairing
   URLs to explicitly configured operators. It never enables remote access or
   a tunnel. After pairing, find the session by title in OpenCode. See
   [pairing](pairing.md) for full-server access, expiry and privacy limits.
   Session-specific links remain unavailable; do not guess UI routes or assume
   Slack membership grants access to a backend transcript.
5. Repository selection and approvals: define the authorization boundary
   first. A directory is not a sandbox, and a new UI must not expand access.

Each feature uses an isolated branch, focused regression tests, the full
`make check` gate, documentation, and independent review before its PR merges.
Do not bypass branch rules or required checks. Stop an iteration when a
material authorization or privacy decision needs an operator's input.
