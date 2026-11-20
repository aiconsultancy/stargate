import { isUtf8 } from "node:buffer";
import type { WebClient } from "@slack/web-api";
import { Effect, Option, Schema, SchemaTransformation } from "effect";
import {
  type Attachment,
  checkAttachments,
  maxAttachmentBytes,
  maxAttachments,
  maxAttachmentTotalBytes,
} from "./attachments";
import {
  settingsPattern,
  settingsRecord,
  settingsStruct,
} from "./settings-schema";

export type SlackFilesFetch = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;
export type SlackUpload = { fileID: string; url: string };

const fileID = Schema.String.check(settingsPattern(/^F[A-Z0-9]+$/));
const channelID = Schema.String.check(settingsPattern(/^[CGD][A-Z0-9]+$/));
const timestamp = Schema.String.check(
  Schema.isMaxCodePoints(64),
  settingsPattern(/^\d+\.\d+$/),
);
const displayTitle = Schema.String.check(
  Schema.isMinCodePoints(1),
  Schema.isMaxCodePoints(255),
  Schema.makeFilter((value) =>
    [...value].every(
      (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
    ),
  ),
);
const filename = displayTitle.check(settingsPattern(/^[^\\/]+$/));
const mime = Schema.String.check(settingsPattern(/^[\w.+-]+\/[\w.+-]+$/)).pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (value) => value.toLowerCase(),
      encode: (value) => value,
    }),
  ),
);
const size = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(maxAttachmentBytes),
);
const share = Schema.Struct({
  ts: Schema.optional(timestamp),
  thread_ts: Schema.optional(timestamp),
}).check(
  Schema.makeFilter(
    (value) => value.ts !== undefined || value.thread_ts !== undefined,
  ),
);
const shares = settingsStruct({
  public: Schema.optional(settingsRecord(Schema.String, Schema.Array(share))),
  private: Schema.optional(settingsRecord(Schema.String, Schema.Array(share))),
});
const slackFile = Schema.Struct({
  id: fileID,
  name: filename,
  mimetype: mime,
  size,
  mode: Schema.Literals(["hosted", "snippet"]),
  is_external: Schema.Literal(false),
  channels: Schema.optional(Schema.Array(Schema.String)),
  groups: Schema.optional(Schema.Array(Schema.String)),
  ims: Schema.optional(Schema.Array(Schema.String)),
  channel: Schema.optional(Schema.String),
  shares: Schema.optional(shares),
  url_private_download: Schema.optional(
    Schema.String.check(Schema.isMaxCodePoints(8192)),
  ),
  url_private: Schema.optional(
    Schema.String.check(Schema.isMaxCodePoints(8192)),
  ),
  duration_ms: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).pipe(
    Schema.catchDecoding(() => Effect.succeed(Option.some(undefined))),
  ),
  // Slack's clip transcript. An unknown shape is treated as no transcript.
  transcription: Schema.optional(
    Schema.Struct({
      status: Schema.String,
      preview: Schema.optional(
        Schema.Struct({
          content: Schema.String,
          has_more: Schema.optional(Schema.Boolean),
        }),
      ),
    }),
  ).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(undefined)))),
});

/** Only a finished, untruncated transcript replaces a provider request. */
function slackTranscript(file: typeof slackFile.Type) {
  const preview = file.transcription?.preview;
  return file.transcription?.status === "complete" &&
    preview &&
    preview.has_more !== true &&
    preview.content.trim()
    ? preview.content
    : undefined;
}
const downloadResponse = Schema.Struct({
  ok: Schema.Literal(true),
  file: slackFile,
});
const shareResponse = Schema.Struct({
  ok: Schema.Literal(true),
  file: Schema.Struct({ id: fileID, shares }),
});
const uploadResponse = Schema.Struct({
  ok: Schema.Literal(true),
  file_id: fileID,
  upload_url: Schema.String.check(Schema.isMaxCodePoints(8192)),
});
const completeResponse = Schema.Struct({
  ok: Schema.Literal(true),
  files: Schema.Array(Schema.Struct({ id: fileID })).check(
    Schema.isBetweenLength(1, 1),
  ),
});

function slackFileURL(value: string): string {
  const url = new URL(value);
  if (
    url.origin !== "https://files.slack.com" ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("Invalid Slack file origin");
  return url.href;
}

function hasChannel(file: typeof slackFile.Type, channel: string): boolean {
  return (
    file.channel === channel ||
    [file.channels, file.groups, file.ims].some((channels) =>
      channels?.includes(channel),
    ) ||
    [file.shares?.public, file.shares?.private].some(
      (group) => (group?.[channel]?.length ?? 0) > 0,
    )
  );
}

function isHTML(mime: string): boolean {
  return mime === "text/html" || mime === "application/xhtml+xml";
}

async function readBounded(
  response: Response,
  length: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing Slack file body");
  let cancelling: Promise<void> | undefined;
  const abort = () => {
    cancelling = reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const data = new Uint8Array(length);
    let used = 0;
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      if (used + chunk.value.byteLength > length)
        throw new Error("Slack file exceeds declared size");
      data.set(chunk.value, used);
      used += chunk.value.byteLength;
    }
    if (used !== length) throw new Error("Slack file size mismatch");
    const start = new TextDecoder().decode(data.subarray(0, 512));
    if (
      /^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b|<script\b)/i.test(
        start,
      )
    )
      throw new Error("Slack returned an HTML page");
    return data;
  } finally {
    signal.removeEventListener("abort", abort);
    await (cancelling ?? reader.cancel().catch(() => {}));
    reader.releaseLock();
  }
}

/** SDK v8 calls need a request-scoped, no-retry client to honour cancellation. */
export class SlackFiles {
  constructor(
    private readonly web: (signal: AbortSignal) => WebClient,
    private readonly botToken: string,
    private readonly request: SlackFilesFetch = globalThis.fetch,
  ) {}

  private async safe<T>(
    signal: AbortSignal,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const stop = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    try {
      stop.throwIfAborted();
      const result = await run(stop);
      stop.throwIfAborted();
      return result;
    } catch {
      // SDK/transport exceptions can contain bearer headers and signed URLs.
      throw new Error(
        "Slack file operation failed or was cancelled; check file scopes and channel access",
      );
    }
  }

  async download(
    ids: readonly string[],
    channel: string,
    signal: AbortSignal,
  ): Promise<Attachment[]> {
    return this.safe(signal, async (stop) => {
      Schema.decodeUnknownSync(channelID)(channel);
      Schema.decodeUnknownSync(
        Schema.Array(fileID).check(Schema.isMaxLength(maxAttachments)),
      )(ids);
      const files: Attachment[] = [];
      let total = 0;
      for (const id of ids) {
        stop.throwIfAborted();
        const { file } = Schema.decodeUnknownSync(downloadResponse)(
          await this.web(stop).files.info({ file: id }),
        );
        const snippet = file.mode === "snippet";
        if (
          file.id !== id ||
          !hasChannel(file, channel) ||
          isHTML(file.mimetype) ||
          (snippet && !file.mimetype.startsWith("text/")) ||
          total + file.size > maxAttachmentTotalBytes
        )
          throw new Error(
            "Slack file metadata does not match the accepted request",
          );
        const url = slackFileURL(
          file.url_private_download ?? file.url_private ?? "",
        );
        const response = await this.request(url, {
          headers: { authorization: `Bearer ${this.botToken}` },
          redirect: "error",
          signal: stop,
        });
        try {
          if (response.status !== 200) throw new Error("Slack download failed");
          const contentType = response.headers
            .get("content-type")
            ?.split(";", 1)[0]
            ?.trim()
            .toLowerCase();
          if (
            !contentType ||
            isHTML(contentType) ||
            (contentType === "application/force-download"
              ? !snippet
              : contentType !== file.mimetype &&
                contentType !== "application/octet-stream")
          )
            throw new Error("Slack file MIME mismatch");
          const declared = response.headers.get("content-length");
          if (
            declared !== null &&
            (!/^\d+$/.test(declared) || Number(declared) !== file.size)
          )
            throw new Error("Slack file length mismatch");
          const data = await readBounded(response, file.size, stop);
          // Slack sends pasted text as force-download. Keep the verified text
          // MIME, and refuse mislabeled binary data before it reaches an agent.
          if (
            snippet &&
            (!isUtf8(data) ||
              data.some(
                (byte) =>
                  byte === 127 ||
                  (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13),
              ))
          )
            throw new Error("Slack snippet must be UTF-8 text");
          const transcript = slackTranscript(file);
          files.push({
            name: file.name,
            mime: file.mimetype,
            data,
            source: {
              id: file.id,
              ...(file.duration_ms !== undefined
                ? { durationMs: file.duration_ms }
                : {}),
              ...(transcript !== undefined ? { transcript } : {}),
            },
          });
          total += data.byteLength;
        } finally {
          await response.body?.cancel().catch(() => {});
        }
      }
      checkAttachments(files);
      return files;
    });
  }

  async reserveUpload(
    name: string,
    length: number,
    signal: AbortSignal,
  ): Promise<SlackUpload> {
    return this.safe(signal, async (stop) => {
      Schema.decodeUnknownSync(filename)(name);
      Schema.decodeUnknownSync(size)(length);
      const result = Schema.decodeUnknownSync(uploadResponse)(
        await this.web(stop).files.getUploadURLExternal({
          filename: name,
          length,
        }),
      );
      return { fileID: result.file_id, url: slackFileURL(result.upload_url) };
    });
  }

  async putUpload(
    url: string,
    data: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    return this.safe(signal, async (stop) => {
      const target = slackFileURL(url);
      Schema.decodeUnknownSync(size)(data.byteLength);
      const response = await this.request(target, {
        method: "POST",
        body: new Uint8Array(data),
        headers: { "content-type": "application/octet-stream" },
        redirect: "error",
        signal: stop,
      });
      try {
        if (response.status !== 200) throw new Error("Slack upload failed");
      } finally {
        await response.body?.cancel().catch(() => {});
      }
    });
  }

  async completeUpload(
    channel: string,
    thread: string,
    id: string,
    title: string,
    signal: AbortSignal,
  ): Promise<void> {
    return this.safe(signal, async (stop) => {
      Schema.decodeUnknownSync(channelID)(channel);
      Schema.decodeUnknownSync(timestamp)(thread);
      Schema.decodeUnknownSync(fileID)(id);
      Schema.decodeUnknownSync(displayTitle)(title);
      // Never retry completion here: a lost response has an uncertain outcome.
      const result = Schema.decodeUnknownSync(completeResponse)(
        await this.web(stop).files.completeUploadExternal({
          channel_id: channel,
          thread_ts: thread,
          files: [{ id, title }],
        }),
      );
      if (result.files[0]?.id !== id)
        throw new Error("Slack upload completion identity changed");
    });
  }

  async sharedIn(
    id: string,
    channel: string,
    thread: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    return this.safe(signal, async (stop) => {
      Schema.decodeUnknownSync(fileID)(id);
      Schema.decodeUnknownSync(channelID)(channel);
      Schema.decodeUnknownSync(timestamp)(thread);
      const result = Schema.decodeUnknownSync(shareResponse)(
        await this.web(stop).files.info({ file: id }),
      );
      if (result.file.id !== id) throw new Error("Slack file identity changed");
      return [result.file.shares.public, result.file.shares.private].some(
        (group) =>
          group?.[channel]?.some(
            (entry) => (entry.thread_ts ?? entry.ts) === thread,
          ),
      );
    });
  }
}
