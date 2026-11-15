import { isUtf8 } from "node:buffer";
import type { WebClient } from "@slack/web-api";
import { z } from "zod";
import {
  type Attachment,
  checkAttachments,
  maxAttachmentBytes,
  maxAttachments,
  maxAttachmentTotalBytes,
} from "./attachments";

export type SlackFilesFetch = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;
export type SlackUpload = { fileID: string; url: string };

const fileID = z.string().regex(/^F[A-Z0-9]+$/);
const channelID = z.string().regex(/^[CGD][A-Z0-9]+$/);
const timestamp = z
  .string()
  .max(64)
  .regex(/^\d+\.\d+$/);
const displayTitle = z
  .string()
  .min(1)
  .max(255)
  .refine((value) =>
    [...value].every(
      (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
    ),
  );
const filename = displayTitle.regex(/^[^\\/]+$/);
const mime = z
  .string()
  .regex(/^[\w.+-]+\/[\w.+-]+$/)
  .transform((value) => value.toLowerCase());
const size = z.number().int().positive().max(maxAttachmentBytes);
const share = z
  .object({ ts: timestamp.optional(), thread_ts: timestamp.optional() })
  .refine((value) => value.ts !== undefined || value.thread_ts !== undefined);
const shares = z.strictObject({
  public: z.record(z.string(), z.array(share)).optional(),
  private: z.record(z.string(), z.array(share)).optional(),
});
const slackFile = z.object({
  id: fileID,
  name: filename,
  mimetype: mime,
  size,
  mode: z.enum(["hosted", "snippet"]),
  is_external: z.literal(false),
  channels: z.array(z.string()).optional(),
  groups: z.array(z.string()).optional(),
  ims: z.array(z.string()).optional(),
  channel: z.string().optional(),
  shares: shares.optional(),
  url_private_download: z.string().max(8192).optional(),
  url_private: z.string().max(8192).optional(),
  duration_ms: z.number().int().positive().optional().catch(undefined),
  // Slack's clip transcript. An unknown shape is treated as no transcript.
  transcription: z
    .object({
      status: z.string(),
      preview: z
        .object({ content: z.string(), has_more: z.boolean().optional() })
        .optional(),
    })
    .optional()
    .catch(undefined),
});

/** Only a finished, untruncated transcript replaces a provider request. */
function slackTranscript(file: z.infer<typeof slackFile>) {
  const preview = file.transcription?.preview;
  return file.transcription?.status === "complete" &&
    preview &&
    preview.has_more !== true &&
    preview.content.trim()
    ? preview.content
    : undefined;
}
const downloadResponse = z.object({ ok: z.literal(true), file: slackFile });
const shareResponse = z.object({
  ok: z.literal(true),
  file: z.object({ id: fileID, shares }),
});
const uploadResponse = z.object({
  ok: z.literal(true),
  file_id: fileID,
  upload_url: z.string().max(8192),
});
const completeResponse = z.object({
  ok: z.literal(true),
  files: z.array(z.object({ id: fileID })).length(1),
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

function hasChannel(file: z.infer<typeof slackFile>, channel: string): boolean {
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
      channelID.parse(channel);
      z.array(fileID).max(maxAttachments).parse(ids);
      const files: Attachment[] = [];
      let total = 0;
      for (const id of ids) {
        stop.throwIfAborted();
        const { file } = downloadResponse.parse(
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
      filename.parse(name);
      size.parse(length);
      const result = uploadResponse.parse(
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
      size.parse(data.byteLength);
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
      channelID.parse(channel);
      timestamp.parse(thread);
      fileID.parse(id);
      displayTitle.parse(title);
      // Never retry completion here: a lost response has an uncertain outcome.
      const result = completeResponse.parse(
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
      fileID.parse(id);
      channelID.parse(channel);
      timestamp.parse(thread);
      const result = shareResponse.parse(
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
