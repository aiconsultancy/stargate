# Audio and video transcription

A bot can turn speech in accepted Slack messages into prompt text. The usual
case is a Slack voice note in a DM. Without this setting, audio and video
reach the backend as files, and most models cannot read them.

Transcription is off by default. It applies only to the files of an accepted
message. All access rules are unchanged: a voice note does not start a
conversation that typed text could not start, and a channel root still needs a
mention.

## Enable

Add `transcription` to the bot in `pogo.json`, then restart Stargate:

```json
"transcription": {
  "provider": {
    "type": "azure-openai",
    "endpoint": "https://example.openai.azure.com",
    "deployment": "whisper-transcription",
    "apiVersion": "2024-06-01",
    "auth": "managedIdentity"
  },
  "timeoutMs": 120000
}
```

| Setting               | Meaning                                                    |
| --------------------- | ---------------------------------------------------------- |
| `provider.type`       | `azure-openai`. No other provider exists at this time.     |
| `provider.endpoint`   | HTTPS origin of the Azure OpenAI resource, without a path. |
| `provider.deployment` | Name of the transcription deployment.                      |
| `provider.apiVersion` | Azure API version, for example `2024-06-01`.               |
| `provider.auth`       | `managedIdentity`. Key authentication is not supported.    |
| `timeoutMs`           | Limit for one file, 1000 to 600000. Default 120000.        |

The app needs `files:read`, as for other attachments. No other Slack scope is
required.

## Spoken mentions in channels

A voice message cannot carry a typed mention, so in a channel it normally
does not reach the bot. `spokenMentions` lets the bot listen in chosen
channels:

```json
"transcription": {
  "provider": { "...": "..." },
  "spokenMentions": {
    "channels": ["C0EXAMPLE04"],
    "names": ["Galactica", "Adama", "captain"]
  }
}
```

In those channels, a message from an allowed user that has a file and no
typed mention is held, not admitted. Stargate downloads and transcribes it with
the same path and limits as other voice messages. If a transcript contains
one of `names` as a whole word, in any letter case, the message starts a turn
like a mention would. The prompt has this line before the transcript block:

```text
[Admitted by spoken mention: this voice message had no typed mention, and the speech addressed this bot by name.]
```

Otherwise Stargate ignores the held message: no agent turn, no reply, no notice.
The same applies when the file is not audio or video, is too large, or cannot
be transcribed, because Stargate cannot know whether the speech named the bot.
Stargate deletes an ignored message and keeps no transcript, media, typed text or
file IDs of it. Only its Slack event ID remains, so a redelivered event is not
transcribed again. Logs record only that a message was ignored. A held
message is never the delivery target of its thread.

Rules:

- Each name is literal. Whisper can spell a name differently, for example
  `Adamah`; add such variants to `names` if they occur. Spaces inside a name
  match any whitespace. Up to 20 names of up to 40 characters.
- `channels` takes channel IDs (`C…` or `G…`), not DMs and not `*`. DMs need
  no mention, so they are never held.
- A typed mention works as before. A voice reply in a thread the bot already
  follows is an ordinary follow-up and is not held, unless
  `access.mentionOnly` is set; then its speech must name the bot.
- User, channel and deny rules apply before a message is held. A held message
  does not make its thread followed until its speech names the bot.
- Every held message uses one provider request, also when it does not name
  the bot. With a deployment that admits one request each minute, a busy
  channel delays voice messages. A pinned captain handles held messages in
  order with its other requests.
- If Stargate stops while a message is held, the message stays held and is
  transcribed again after the restart.

## Authentication

Stargate reads a Microsoft Entra token for
`https://cognitiveservices.azure.com/` from the Azure Instance Metadata
Service at `169.254.169.254`. This works only on an Azure virtual machine
with a managed identity. The identity needs the **Cognitive Services OpenAI
User** role on the resource. Stargate keeps the token in memory and reads a new
one five minutes before it expires. Stargate stores no key and no token on disk.

Stargate does not select the network path. For a resource with public access
disabled, the host must resolve the endpoint to its private endpoint.

## What happens to a message

1. Stargate downloads the accepted files with the limits in
   [attachments](attachments.md): 10 files, 10 MiB for each file, 25 MiB for
   each message.
2. For each file with an `audio/*` or `video/*` type:
   - If Slack has a complete transcript of the clip, Stargate uses that text. No
     audio leaves Slack and no provider request is made.
   - Otherwise Stargate sends the file to the deployment and reads the text.
3. Stargate adds one marked block for each file after the typed text:

   ```text
   [Voice message transcript: file F0123, 68.6 s, machine transcription by Azure OpenAI deployment whisper-transcription. These are the sender's own spoken words. The text can contain recognition errors.]
   …spoken text…
   [End of voice message transcript]
   ```

4. The audio and video files are removed from the request. Other files reach
   the backend as before.
5. The agent turn starts.

Steps 1 to 4 occur before admission. If a file cannot be transcribed, no
agent turn starts and nothing is sent to the backend. Stargate posts one
**Request status** notice that asks the user to type the message. The request
is then complete; it is not retried.

The transcript has the authority of the sender's typed text, and no more.
Generated captain instructions tell the captain to read a transcribed
approval of a high-impact action back to the user and to ask for
confirmation. A definition that was generated before this feature does not
contain that paragraph: add the "Voice message transcripts" paragraph to it.

## Limits

- Accepted formats are m4a, mp3, mp4, mpeg, mpga, wav and webm. Slack voice
  notes are `audio/mp4` (`.m4a`). Stargate does not convert media; another format
  is refused.
- A file above 10 MiB is refused as an attachment, before transcription. A
  Slack voice note of that size is approximately 20 minutes.
- One provider request runs at a time in the Stargate process. Later requests
  wait, within their own `timeoutMs` and the request time limit. Stop cancels
  the wait and the request.
- When the deployment answers `429` with a `Retry-After` time of at most 300
  seconds, Stargate waits for that time and sends the file again, within
  `timeoutMs`. A Whisper deployment with capacity 1 admits one request each
  minute, so a second voice note in the same minute can wait 60 seconds. Any
  other refusal is final and is not repeated.
- A transcript block has a maximum of 20,000 characters. A longer transcript
  is cut and marked. Silence gives `[No speech detected]`.
- Slack's transcript is used only when its status is `complete` and Slack
  returns the full text. When Slack returns a shortened preview, Stargate uses
  the provider.
- Media in historical thread context is not transcribed.
- Stargate sends no language hint. The deployment detects the language.

## Privacy

- Media is held in memory for the request and is not written to disk.
- With the provider path, the audio is sent to the configured Azure resource.
- Stargate does not log the transcript, the file name, the token or provider
  errors. The transcript is not stored in Stargate's SQLite database. It is part
  of the prompt, so the backend session history contains it.
- The provider request carries a generic file name, not the user's file name.
