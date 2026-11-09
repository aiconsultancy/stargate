# Images and attachments

Pogo supports files on accepted Slack messages and explicit file publication in
agent replies. User and channel allowlists, deny rules, bot rejection and source
ownership apply to both directions. OAuth scopes do not change those rules.

## Slack to agent

The app needs `files:read`. Pogo stores the accepted Slack file IDs before ACK,
then resolves them with `files.info` using that registration's bot token. It
checks that the hosted file is shared in the accepted channel. It does not trust
download URLs supplied in a message or follow redirects with a bot token.

File-only DMs, and file-only replies in followed threads, are accepted. A channel
root still needs a mention; `mentionOnly` still requires one on every request.
Normal `file_share` messages are supported, not edited or bot messages. Files in
historical thread context remain excluded: this forwards the accepted message's
attachments, not every file in a channel or thread.

Downloads are bounded to 10 files, 10 MiB per file and 25 MiB total per request.
Slack-hosted private downloads use authentication only for `files.slack.com`;
external files, redirects and inaccessible files fail closed. File failures are
reported before agent admission instead of silently dropping attachments.

- OpenCode receives native inline file data with name and MIME type. Whether a
  particular model can interpret a format remains a backend/model constraint.
- Pi 1.5 supports PNG, JPEG, GIF and WebP on vision-capable models, and valid
  UTF-8 text, JSON, XML, YAML and JavaScript. It has no document input block:
  PDFs and other binary files are refused before submission, not renamed as text.
- A custom backend must declare `supportsAttachments` and accept the optional
  sixth `prompt` argument. Otherwise a file-bearing request fails before admission.

Files are untrusted input. Pogo does not execute them, unpack archives or treat
their contents as instructions. The agent must apply the project's normal rules.

## Agent to Slack

The app needs `files:write` and `files:read`. Publish a requested local file in
final assistant text using an explicit image-style marker:

```markdown
![Desktop proof](file:///tmp/opencode/proof-desktop.png)
![Report](file:///tmp/opencode/report.pdf)
![Phone proof](file:///tmp/opencode/phone proof.png)
```

This syntax can publish any regular file type. The caption replaces the marker
in the text reply; the file is uploaded into the same source channel and thread.
Crew members report paths to the captain rather than posting to Slack directly.
Native tool-result files are private and are never exported automatically.
Ordinary `[label](file:///path)` citations and markers inside code are not uploads.
Local paths are hidden from streamed previews and Slack text. HTTP images and
Linear Resources links do not cause downloads or uploads.

The gateway and backend must share the local filesystem. Pogo refuses local-file
publication from a non-loopback OpenCode endpoint. It rejects symlinks, special
files, hidden/credential/state paths, empty files and files over the limits.
It records size and SHA-256, then rechecks the file before uploading. MIME types
come from extensions, not content inspection. These checks are not a sandbox:
a trusted agent can explicitly publish other readable, non-denied files. Only
publish evidence the user requested.

The outbox saves file metadata and Slack upload IDs. Retrying delivery never
re-prompts the agent or repeats its tools. An abandoned reservation can leave a
private, unshared upload. Finalization is one-shot: after an ambiguous response,
Pogo checks for the exact channel/thread share. If it cannot confirm that share,
it reports an unavailable or unconfirmed attachment rather than completing again
or posting a replacement. This is not exactly-once delivery. Text and file
delivery are separate; a visible text reply is not proof its files were shared.

## Setup and existing requests

The generated manifest includes `files:read` and `files:write`. Existing apps
need these scopes granted to their installed bot token; editing a local manifest
does not grant them. Reauthorize the app if they are absent. Keep tokens out of
chat and command arguments.
See the [development scope audit](slack-scopes.md) for broader useful capabilities.

Existing completed requests are not replayed or bulk-exported. A historical proof
file can be published in a new, explicitly requested reply to its proven source.
Existing custom agent definitions are not overwritten by installation. Add the
publication rule to their referenced instructions when updating an existing team.
