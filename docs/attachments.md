# Images and attachments

Stargate supports files on accepted Slack and IRC messages and explicit file
publication in agent replies. User and channel allowlists, deny rules, bot
rejection and source ownership apply to both directions. See [IRC files](irc.md#files)
for Subspace chat uploads and IRC FILEHOST.

## Slack to agent

The app needs `files:read`. Stargate stores the accepted Slack file IDs before ACK,
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

Pasted Slack snippets, including long Markdown, are accepted as UTF-8 text.
Slack's generic download content type is accepted only for Slack-hosted
snippets identified as text. Invalid UTF-8, binary control bytes and HTML
download pages are refused.

- OpenCode receives native inline file data with name and MIME type. Whether a
  particular model can interpret a format remains a backend/model constraint.
- Pi 1.5 supports PNG, JPEG, GIF and WebP on vision-capable models, and valid
  UTF-8 text, JSON, XML, YAML and JavaScript. It has no document input block:
  PDFs and other binary files are refused before submission, not renamed as text.
- A custom backend must declare `supportsAttachments` and accept the optional
  sixth `prompt` argument. Otherwise a file-bearing request fails before admission.

Files are untrusted input. Stargate does not execute them, unpack archives or treat
their contents as instructions. The agent must apply the project's normal rules.

Audio and video files are passed to the backend as files unless the bot sets
`transcription`. With that setting they become transcript text and are not
passed on. See [transcription](transcription.md).

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

The gateway and backend must share the local filesystem. Stargate refuses local-file
publication from a non-loopback OpenCode endpoint. It rejects symlinks, special
files, hidden/credential/state paths, empty files and files over the limits.
Stage evidence under `join(os.tmpdir(), "opencode")`, evaluated in the gateway
process at inspection and each upload read. Stargate and OpenCode services MUST
share `TMPDIR`; for example, both can use `TMPDIR=$HOME/.cache/tmp` to publish
from `$HOME/.cache/tmp/opencode`. Hidden ancestors of that scratch root are
allowed, but hidden paths below it (including `.git` and `.ssh`) and credential
files are still refused. Paths outside scratch keep the existing rules;
unrelated files under `~/.cache` are not allowed.
Stargate records size and SHA-256, then rechecks the file before uploading. MIME types
come from extensions, not content inspection. These checks are not a sandbox:
a trusted agent can explicitly publish other readable, non-denied files. Only
publish evidence the user requested.

The outbox saves file metadata and Slack upload IDs. Retrying delivery never
re-prompts the agent or repeats its tools. An abandoned reservation can leave a
private, unshared upload. Finalization is one-shot: after an ambiguous response,
Stargate checks for the exact channel/thread share. If it cannot confirm that share,
it reports an unavailable or unconfirmed attachment rather than completing again
or posting a replacement. This is not exactly-once delivery. Text and file
delivery are separate; a visible text reply is not proof its files were shared.

## Giving officers a file tool

A captain or another officer can prepare files without a shell using the optional
Bun TypeScript stdio MCP server on Linux or macOS. Register it in each officer's agent profile and grant
that officer the `prepare_file` tool. Give each officer their own staging and
export directories. The gateway needs read access to the export directory.
For example, use this command array in an OpenCode local MCP registration:

```json
[
  "bun",
  "--no-env-file",
  "--no-install",
  "/srv/stargate/scripts/officer-files.ts",
  "--staging",
  "/srv/officers/captain/outbox",
  "--exports",
  "/srv/exports/captain",
  "--socket",
  "/run/stargate/subspace/captain/api.sock"
]
```

The socket supplies the officer's own Subspace identity. Installations with an
authenticated loopback MCP relay can use `--port PORT --actor OFFICER` instead.
Use a plain filename and an allowed extension. Each file must contain 1 byte to 10 MiB. New text accepts up to 65,536 UTF-8 bytes. A staged file must be owned by the officer, have one hard link and be writable only by its owner. Both directories must be canonical absolute paths. Create the export directory
setgid and grant its group to the intended gateway. Apply a retention policy to
prepared exports after the outbox has completed delivery.

| Source                    | Tool arguments                        | Result                                                                                                    |
| ------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Issue image or document   | `source: "issue"`, `issue`, `mediaId` | Verifies the listed attachment belongs to this issue and retrieves its bytes with the officer's identity. |
| Local image or document   | `source: "staged"`, `fileName`        | Reads one regular file by name from the officer's staging directory.                                      |
| New text, Markdown or CSV | `source: "text"`, `fileName`, `text`  | Writes the supplied UTF-8 text. Use only the file name and text for this source.                          |

To send a file another officer has already shared, use `source: "upload"` with its `reference`. The tool retrieves the original through the receiving officer's existing access and checks its size and SHA-256.

Use the returned marker in the intended reply for Slack, IRC FILEHOST or an inline
image preview in Teams (PNG, JPEG, WebP or GIF input up to 10 MiB). To share a supported document or image with Subspace desktop
users over IRC, pass a fresh `chatUploadId` UUID and post the returned reference.
This creates a 30-day copy readable by active Subspace members. Reuse the UUID
if delivery is uncertain. To share both ways, prepare a marker for Teams and call again with the upload UUID for IRC. CSV and PPTX can be staged locally. The IRC chat upload accepts neither type.

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

### Sending a Markdown document preview to Teams

When the officer profile selects an offline browser, call `prepare_file` with
`preview: "teams"` and the original file source. It accepts an issue attachment,
an existing upload, an outbox file, or new text. The file must be Markdown or
plain text. The returned marker points to a labelled PNG preview. Include it
and the original file name in the Teams reply. If the tool reports several
pages, set `page` on subsequent calls. Do not supply a chat upload ID for a
preview.

For a local shell workflow, the same renderer takes Markdown on stdin:

```sh
bun scripts/markdown-preview.ts \
  --playwright /srv/browser-tools/node_modules/playwright/index.mjs \
  --name notes.md --output /srv/officers/captain/outbox/notes-preview.png < notes.md
```

Use `--chromium` when the installation selects a specific reviewed executable.
Prepare the resulting PNG from staging to get its publication marker.
