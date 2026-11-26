import { randomUUID } from "node:crypto";
import { type RequestOptions, get } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { Result, Schema } from "effect";
import {
  type Attachment,
  maxAttachmentBytes,
  maxAttachmentTotalBytes,
  maxAttachments,
} from "../../chat/attachments/attachments";
import type { TeamsConfig } from "../../config";
import { ManagedIdentityTokenProvider, untilAborted } from "./connector";
import { readAttachmentResponse } from "./inbound-body";
import type { TeamsActivity } from "./activity";

const downloadInfo = "application/vnd.microsoft.teams.file.download.info";
const unavailable = "teams:document-unavailable";
const prefix = "teams:document:";
const maxQueuedDocuments = 128;
const documentTTL = 2 * 60_000;
const maxDownloadUrl = 8192;

const documentTypes: ReadonlyMap<string, string> = new Map([
  ["txt", "text/plain"],
  ["md", "text/markdown"],
  ["markdown", "text/markdown"],
  ["csv", "text/csv"],
  ["json", "application/json"],
  ["pdf", "application/pdf"],
]);

const contentSchema = Schema.Struct({
  downloadUrl: Schema.String.check(Schema.isMaxCodePoints(maxDownloadUrl)),
  fileType: Schema.String.check(Schema.isMaxCodePoints(16)),
  tenantId: Schema.optional(Schema.String),
});

const decodeContent = Schema.decodeUnknownResult(contentSchema);

type DocumentSource = {
  channel: string;
  hostname: string;
  path: string;
  extension: string;
  mime: string;
  expires: number;
};

function documentAttachments(activity: TeamsActivity) {
  return (activity.attachments ?? []).filter(
    (item) =>
      item.contentType?.split(";", 1)[0]?.trim().toLowerCase() === downloadInfo,
  );
}

export function isDocumentRef(ref: string) {
  return ref === unavailable || ref.startsWith(prefix);
}

function documentSource(
  activity: TeamsActivity,
  content: unknown,
  tenant: string,
) {
  const decoded = decodeContent(content);

  if (Result.isFailure(decoded)) {
    return;
  }

  const { downloadUrl, fileType, tenantId } = decoded.success;

  const fileTenant =
    tenantId ??
    activity.channelData?.tenant?.id ??
    activity.conversation.tenantId;

  const match = /^https:\/\/([a-z0-9.-]+)(\/[!-~]*)$/i.exec(downloadUrl);
  const hostname = match?.[1]?.toLowerCase();
  const path = match?.[2];
  const extension = fileType.toLowerCase();
  const mime = documentTypes.get(extension);

  if (
    !hostname ||
    !path ||
    path.startsWith("//") ||
    match?.[0] !== downloadUrl ||
    /[#\\]/.test(path) ||
    !mime ||
    fileTenant?.toLowerCase() !== tenant.toLowerCase()
  ) {
    return;
  }

  return {
    channel: activity.conversation.id,
    hostname,
    path,
    extension,
    mime,
    expires: Date.now() + documentTTL,
  };
}

/** Send the original request target as-is. A redirect is a failed download. */
export function requestDocument(
  hostname: string,
  path: string,
  token: string,
  signal: AbortSignal,
  request: (
    options: RequestOptions,
    respond: (response: IncomingMessage) => void,
  ) => ClientRequest = get,
) {
  return new Promise<Response>((resolve, reject) => {
    request(
      { hostname, path, headers: { authorization: `Bearer ${token}` }, signal },
      (response) => {
        if (response.statusCode !== 200) {
          response.destroy();
          resolve(
            new Response(null, {
              status: response.statusCode === 401 ? 401 : 502,
            }),
          );

          return;
        }

        const headers = new Headers();

        for (const name of ["content-type", "content-length"] as const) {
          const value = response.headers[name];

          if (value !== undefined) {
            headers.set(name, value);
          }
        }

        const body: unknown = Readable.toWeb(response);

        if (!(body instanceof ReadableStream)) {
          response.destroy();
          reject(new Error("Teams document stream unavailable"));

          return;
        }

        resolve(new Response(body, { headers }));
      },
    ).on("error", reject);
  });
}

function validateDocument(data: Uint8Array, mime: string, declared: string) {
  if (
    declared &&
    declared !== "application/octet-stream" &&
    declared !== mime &&
    !(declared === "text/plain" && mime !== "application/pdf")
  ) {
    throw new Error("Unexpected Teams document content type");
  }

  if (mime === "application/pdf") {
    if (Buffer.from(data.subarray(0, 5)).toString("ascii") !== "%PDF-") {
      throw new Error("Invalid Teams PDF");
    }

    return;
  }

  const text = new TextDecoder("utf-8", { fatal: true }).decode(data);

  if (/[^\P{Cc}\t\n\r]/u.test(text)) {
    throw new Error("Invalid Teams text document");
  }
}

/** Only opaque, registration-local references enter durable jobs. */
export class TeamsDocuments {
  private readonly pending = new Map<string, DocumentSource>();
  private readonly tokens = new Map<string, ManagedIdentityTokenProvider>();

  public constructor(
    private readonly config: Pick<
      TeamsConfig,
      "attachmentFileHosts" | "botClientId" | "tenantId"
    >,
    private readonly io: {
      request?: typeof requestDocument;
      fetch?: typeof globalThis.fetch;
    } = {},
  ) {
    for (const host of config.attachmentFileHosts ?? []) {
      this.tokens.set(
        host,
        new ManagedIdentityTokenProvider({
          clientId: config.botClientId,
          resource: `https://${host}`,
          ...(io.fetch && { fetch: io.fetch }),
        }),
      );
    }
  }

  public prepare(
    activity: TeamsActivity,
    images: string[],
  ): {
    files: string[];
    hasDocuments: boolean;
    remember?: () => void;
  } {
    const documents = this.tokens.size > 0 ? documentAttachments(activity) : [];

    if (documents.length === 0) {
      return { files: images, hasDocuments: false };
    }

    const refused = { files: [unavailable], hasDocuments: true };

    if (
      activity.conversation.conversationType !== "personal" ||
      images.length + documents.length > maxAttachments
    ) {
      return refused;
    }

    const now = Date.now();

    for (const [ref, source] of this.pending) {
      if (source.expires <= now) {
        this.pending.delete(ref);
      }
    }

    if (this.pending.size + documents.length > maxQueuedDocuments) {
      return refused;
    }

    const pending = new Map<string, DocumentSource>();

    for (const document of documents) {
      const source = documentSource(
        activity,
        document.content,
        this.config.tenantId,
      );

      if (!source || !this.tokens.has(source.hostname)) {
        return refused;
      }

      pending.set(prefix + randomUUID(), source);
    }

    return {
      files: images.concat([...pending.keys()]),
      hasDocuments: true,
      remember: () => {
        for (const [ref, source] of pending) {
          this.pending.set(ref, source);
        }
      },
    };
  }

  public async download(
    refs: readonly string[],
    channel: string,
    images: readonly Attachment[],
    signal: AbortSignal,
  ) {
    const files: Attachment[] = [];

    let remaining =
      maxAttachmentTotalBytes -
      images.reduce((sum, image) => sum + image.data.byteLength, 0);

    for (const ref of refs) {
      signal.throwIfAborted();

      const source = this.pending.get(ref);
      const tokens = source && this.tokens.get(source.hostname);

      if (
        !source ||
        !tokens ||
        source.channel !== channel ||
        source.expires <= Date.now()
      ) {
        throw new Error("Teams document unavailable");
      }

      const token = await untilAborted(tokens.getToken(), signal);

      signal.throwIfAborted();

      if (this.pending.get(ref) !== source || source.expires <= Date.now()) {
        throw new Error("Teams document unavailable");
      }

      this.pending.delete(ref);

      const response = await (this.io.request ?? requestDocument)(
        source.hostname,
        source.path,
        token,
        signal,
      );

      if (response.status === 401) {
        tokens.invalidate();
      }

      const data = await readAttachmentResponse(
        response,
        Math.min(remaining, maxAttachmentBytes),
        signal,
      );

      const declared =
        response.headers
          .get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase() ?? "";

      validateDocument(data, source.mime, declared);
      signal.throwIfAborted();

      files.push({
        name: `document-${files.length + 1}.${source.extension}`,
        mime: source.mime,
        data,
      });
      remaining -= data.byteLength;
    }

    return files;
  }
}
