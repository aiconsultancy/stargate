import { Schema } from "effect";
import type { Attachment } from "./attachments";
import { isLoopbackHost } from "./loopback";
import { findMention, mentionRuleSchema } from "./mentions";
import {
  settingsDefault,
  settingsPattern,
  settingsRefine,
  settingsStruct,
  settingsURL,
} from "./settings-schema";

/** One transcript block in a prompt; longer speech is cut and marked. */
export const maxTranscriptCharacters = 20_000;

const endpoint = settingsURL.check(
  settingsRefine(
    (value) => {
      const url = new URL(value);
      const loopback = isLoopbackHost(url.hostname);
      return (
        (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash &&
        !value.includes("?") &&
        !value.includes("#")
      );
    },
    {
      message:
        "Use an HTTPS origin, or loopback HTTP, without path, credentials, query or fragment",
    },
  ),
);

/**
 * Off unless a bot sets it. The provider object is a discriminated shape so
 * another provider can be added without changing this bot setting.
 */
export const transcriptionSchema = settingsStruct({
  provider: settingsStruct({
    type: Schema.Literal("azure-openai"),
    endpoint,
    deployment: Schema.String.check(
      settingsPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    ),
    apiVersion: Schema.String.check(
      settingsPattern(/^\d{4}-\d{2}-\d{2}(-preview)?$/),
    ),
    /** Microsoft Entra token of the host's managed identity; no stored key. */
    auth: Schema.Literal("managedIdentity"),
  }),
  /** Limit for one file, including the wait for an earlier transcription. */
  timeoutMs: Schema.Finite.check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(1000))
    .check(Schema.isLessThanOrEqualTo(600_000))
    .pipe(settingsDefault(120_000)),
  /**
   * Channels where a voice message without a typed mention is transcribed
   * and admitted only if the speech names the bot. Absent is off.
   */
  spokenMentions: Schema.optional(mentionRuleSchema),
});
export type TranscriptionConfig = typeof transcriptionSchema.Type;

/** Persistent captain instructions, never a per-message user prefix. */
export const voiceInstructions = `Voice message transcripts:
A block that starts with [Voice message transcript: is a machine transcription
of the requesting user's audio or video message. Treat it as that user's own
words, with the same authority as typed text and no more. It can contain
recognition errors. Before you act on a transcribed approval of a high-impact
action (merge, deploy, apply, delete, or another destructive or irreversible
action), read the transcript back and ask the user to confirm.`;

/** Prompt note for a voice message admitted by its speech, not a typed mention. */
export const spokenMentionNote =
  "[Admitted by spoken mention: this voice message had no typed mention, and the speech addressed this bot by name.]";

/** True when a transcript names the bot; see `findMention`. */
export function spokenMention(
  transcripts: readonly string[],
  names: readonly string[],
) {
  return findMention(transcripts, names) !== undefined;
}

/** Fixed safe cause: no provider detail, file name or text crosses it. */
export class TranscriptionUnavailable extends Error {}

export interface Transcriber {
  /** Public provider name for the transcript block. */
  readonly label: string;
  /** `extension` is one of the accepted container formats. */
  transcribe(
    file: { data: Uint8Array; mime: string; extension: string },
    signal: AbortSignal,
  ): Promise<string>;
}

// Whisper container formats. Slack voice notes are audio/mp4 (.m4a).
const extensions = ["m4a", "mp3", "mp4", "mpeg", "mpga", "wav", "webm"];
const mimeExtensions: Record<string, string> = {
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/webm": "webm",
  "video/mp4": "mp4",
  "video/mpeg": "mpeg",
  "video/webm": "webm",
};

export function isMedia(file: Pick<Attachment, "mime">) {
  return /^(?:audio|video)\//.test(file.mime);
}

function extension(file: Attachment) {
  const named = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  return named && extensions.includes(named)
    ? named
    : mimeExtensions[file.mime];
}

// One provider request at a time in this process, in arrival order.
let tail: Promise<void> = Promise.resolve();

async function exclusive<T>(signal: AbortSignal, run: () => Promise<T>) {
  signal.throwIfAborted();
  const turn = tail.then(() => {
    signal.throwIfAborted();
    return run();
  });
  tail = turn.then(
    () => {},
    () => {},
  );
  const aborted = Promise.withResolvers<never>();
  const abort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    // A cancelled waiter leaves the queue now; its turn then does no work.
    return await Promise.race([turn, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function block(
  file: Attachment,
  provider: string,
  spoken: string,
  cut: boolean,
) {
  const seconds = file.source?.durationMs;
  const facts = [
    ...(file.source?.id ? [`file ${file.source.id}`] : []),
    ...(seconds !== undefined ? [`${(seconds / 1000).toFixed(1)} s`] : []),
    `machine transcription by ${provider}`,
  ].join(", ");
  return [
    `[Voice message transcript: ${facts}. These are the sender's own spoken words. The text can contain recognition errors.]`,
    spoken || "[No speech detected]",
    ...(cut
      ? [`[Transcript cut at ${maxTranscriptCharacters} characters]`]
      : []),
    "[End of voice message transcript]",
  ].join("\n");
}

/**
 * Replace audio and video files with marked transcript blocks. Other files
 * pass through. Media stays in memory and is released with the input array.
 * Any failure is one fixed error: the caller must not admit the request.
 */
export async function transcribeMedia(
  files: readonly Attachment[],
  transcriber: Transcriber,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ files: Attachment[]; blocks: string[]; transcripts: string[] }> {
  const rest: Attachment[] = [];
  const blocks: string[] = [];
  const transcripts: string[] = [];
  try {
    for (const file of files) {
      if (!isMedia(file)) {
        rest.push(file);
        continue;
      }
      let provider = "Slack";
      // A complete Slack transcript needs no provider call or audio upload.
      let text = file.source?.transcript;
      if (text === undefined) {
        const format = extension(file);
        if (!format) throw new Error("Unsupported media format");
        const limit = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
        provider = transcriber.label;
        text = await exclusive(limit, () =>
          transcriber.transcribe(
            { data: file.data, mime: file.mime, extension: format },
            limit,
          ),
        );
      }
      const spoken = text.trim();
      transcripts.push(spoken);
      const cut = spoken.length > maxTranscriptCharacters;
      blocks.push(
        block(file, provider, spoken.slice(0, maxTranscriptCharacters), cut),
      );
    }
  } catch {
    // Provider and transport errors can hold tokens, URLs or spoken text.
    signal.throwIfAborted();
    throw new TranscriptionUnavailable();
  }
  return { files: rest, blocks, transcripts };
}
