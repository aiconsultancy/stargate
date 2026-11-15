# Slack scopes for development

OAuth grants describe what the bot token can do. Stargate's tools, event subscriptions,
channel membership and access rules are separate. Adding a scope does not install
a tool or authorize arbitrary writes. Keep user/channel allowlists, deny rules,
bot rejection and task-origin routing unchanged when expanding development access.

## Required by current Stargate

| Scope                                              | Use                                                                   |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| `app_mentions:read`                                | Requests that mention the bot.                                        |
| `channels:history`, `groups:history`, `im:history` | Accepted messages and initial thread context in joined conversations. |
| `chat:write`                                       | Replies, previews and status messages.                                |
| `reactions:write`                                  | Explicit reaction replies.                                            |
| `commands`                                         | `/pogo`, `/cron` and interactive controls.                            |
| `files:read`                                       | Resolve/download accepted files and confirm an upload's exact share.  |
| `files:write`                                      | Upload requested evidence to the proven source thread.                |

The app-level Socket Mode token separately needs `connections:write`.

## Broad development additions

For a development/beta bot, this is a useful capability expansion rather than a
minimum-permission profile. Preserve existing grants and add approved missing
scopes; do not replace a broader installed app with the generated baseline.

| Scope                               | Capability                                             | Stargate status                                                 |
| ----------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------- |
| `channels:read`, `groups:read`      | Discover joined conversations and metadata.            | Diagnostic/future tools.                                        |
| `im:read`, `im:write`               | Inspect and open one-to-one DMs.                       | Future tools.                                                   |
| `mpim:read`, `mpim:history`         | Inspect/read group DMs.                                | Needs `message.mpim` subscription and an explicit start policy. |
| `users:read`, `users:read.email`    | Resolve people and email addresses.                    | Future tools; email requires both.                              |
| `usergroups:read`                   | Resolve user groups and their members.                 | Future tools.                                                   |
| `pins:read`, `pins:write`           | Inspect and manage pinned context.                     | Future tools; writes still need task authority.                 |
| `chat:write.public`                 | Post to a permitted public channel without membership. | Affects delivery permission, not allowlists.                    |
| `channels:join`                     | Explicitly join public channels.                       | Future tools.                                                   |
| `reactions:read`, `emoji:read`      | Inspect reactions and available emoji.                 | Diagnostic/future tools.                                        |
| `bookmarks:read`, `bookmarks:write` | Read/manage channel bookmarks.                         | Future tools.                                                   |
| `canvases:read`, `canvases:write`   | Read/manage canvases.                                  | Future tools.                                                   |
| `links:read`, `links:write`         | Receive/manage link unfurls.                           | Separate event/tool integration.                                |

An installed development bot may already have many of these. Audit the token's
actual `x-oauth-scopes` response metadata, not only a source manifest. Do not
print tokens or copied authentication responses in reports.

One operator audit found a development app already broader than the generated
manifest, including native/remote files, reactions, modern search, canvases,
bookmarks, links, assistant, skills, MCP and trigger grants. No media scope was
missing. Useful missing additions were `im:read`, `im:write`, `mpim:read`,
`mpim:history`, `users:read`, `users:read.email`, `usergroups:read`, `pins:read`,
`pins:write`, `chat:write.public` and `channels:join`. These are recommendations,
not evidence that the installed token or Stargate implementation changed.

## Do not conflate these capabilities

- Native scheduled messages use existing `chat:write`; there is no separate
  scheduled-message scope. Stargate cron is a different mechanism.
- `remote_files:write` is not the native file upload permission.
- Modern real-time search uses its own granular scopes and event `action_token`.
  Stargate does not currently retain/use that token for search. Its storage rules
  require separate design before search results enter durable context.
- Private/DM/group-DM search scopes in the current documentation require a user
  token, not a larger bot scope array. Do not silently add user impersonation.
- Current documentation conflicts on modern bot support for `mpim:write`: the
  scope page lists User/Legacy Bot, while `conversations.open` lists it for bots.
  Validate a candidate app manifest before promising group-DM creation support.
- Workspace administration, audit logs, organization management and destructive
  channel/user administration are separate from this development bot profile.

New grants require app reauthorization. Editing a source manifest does not change
installed tokens. Export and preserve the app's existing manifest before an
approved update; do not silently remove unrelated grants or settings.

The Slack CLI's typed manifest model can omit newer settings such as enabled
PKCE. A clean manifest diff cannot prove preservation of fields that the model
drops. If validation reports that PKCE cannot be disabled, do not force sync or
paste the CLI export as a full replacement. Add approved Bot Token Scopes in App
Settings, preserve User Token Scopes and OAuth settings, add any approved event
subscription, then reauthorize. See the CLI's
[manifest model](https://github.com/slackapi/slack-cli/blob/main/internal/shared/types/app_manifest.go).

References: [auth.test](https://docs.slack.dev/reference/methods/auth.test),
[file upload](https://docs.slack.dev/reference/methods/files.getUploadURLExternal),
[file reads](https://docs.slack.dev/reference/methods/files.info),
[group-DM scope](https://docs.slack.dev/reference/scopes/mpim.write),
[conversation opening](https://docs.slack.dev/reference/methods/conversations.open),
[real-time search](https://docs.slack.dev/apis/web-api/real-time-search-api).
