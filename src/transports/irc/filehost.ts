import {
  type Attachment,
  UploadRefused,
  checkAttachments,
  maxAttachmentBytes,
  maxAttachmentTotalBytes,
  maxAttachments,
  safeAttachmentMime,
} from "../../chat/attachments/attachments";
import { isLoopbackAddress } from "../../lib/loopback";

/**
 * Soju.im/FILEHOST (draft/FILEHOST): an HTTPS upload URL that the IRC server
 * advertises. Uploads POST with HTTP Basic (the SASL PLAIN credentials) and
 * answer 201 with a Location; files are read with GET.
 * https://github.com/emersion/soju/blob/master/doc/ext/filehost.md
 */

/**
 * A usable FILEHOST URL, or undefined. HTTPS always; plain HTTP only on
 * loopback and only when the IRC connection itself is plaintext (the spec
 * forbids HTTP under TLS IRC). Never credentials, query or fragment.
 */
export function filehostURL(value: string, tlsIrc: boolean) {
  if (!URL.canParse(value)) {
    return;
  }

  const url = new URL(value);

  if (url.username || url.password || url.search || url.hash) {
    return;
  }

  if (url.protocol === "https:") {
    return url;
  }

  if (url.protocol === "http:" && !tlsIrc && isLoopbackAddress(url.hostname)) {
    return url;
  }

  return;
}

/** A hosted file URL fit to post: the FILEHOST origin, no userinfo. */
export function safeFileURL(url: URL, filehost: URL) {
  return url.origin === filehost.origin && !url.username && !url.password;
}

/** File name from Content-Disposition, else the URL's last path segment. */
function fileName(disposition: string | null, url: URL) {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition ?? "")?.[1];
  const plain = /filename="?([^";]+)"?/i.exec(disposition ?? "")?.[1];
  let name = "";

  try {
    name = decodeURIComponent(
      star ?? plain ?? url.pathname.split("/").at(-1) ?? "",
    );
  } catch {
    name = "";
  }

  const safe = Array.from(name)
    .filter(
      (char) =>
        char.charCodeAt(0) >= 32 &&
        char.charCodeAt(0) !== 127 &&
        char !== "/" &&
        char !== "\\",
    )
    .join("")
    .trim()
    .slice(0, 255);

  return safe || "file";
}

async function readBounded(
  response: Response,
  limit: number,
  signal: AbortSignal,
) {
  const reader = response.body?.getReader();

  if (!reader) {
    throw new Error("FILEHOST response has no body");
  }

  const parts: Uint8Array[] = [];
  let used = 0;

  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      used += chunk.value.byteLength;

      if (used > limit) {
        throw new Error("FILEHOST file too large");
      }

      parts.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  const data = new Uint8Array(used);
  let offset = 0;

  for (const part of parts) {
    data.set(part, offset);
    offset += part.byteLength;
  }

  return data;
}

/**
 * Answers that reject the request itself (malformed, credentials, size,
 * type): the FILEHOST stored nothing, so another upload is safe. Any other
 * status, including 429 (a limiter may run after the store) and every 5xx
 * (a server can fail after storing), leaves the outcome uncertain.
 */
const refusedStatuses = new Set([400, 401, 403, 413, 415]);

function uploadDisposition(name: string) {
  const ascii = /^[ -~]+$/.test(name) && !/["\\]/.test(name);

  return ascii
    ? `attachment; filename="${name}"`
    : `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function uploadedLocation(response: Response, target: URL) {
  if (response.status !== 201) {
    throw refusedStatuses.has(response.status)
      ? new UploadRefused()
      : new Error("FILEHOST upload unconfirmed");
  }

  const location = response.headers.get("location");

  if (!location) {
    throw new Error("FILEHOST upload unconfirmed");
  }

  // Public links must stay on the FILEHOST origin and omit credentials.
  const url = URL.canParse(location, target)
    ? new URL(location, target)
    : undefined;

  if (!url || !safeFileURL(url, target)) {
    throw new Error("FILEHOST returned an unsafe location");
  }

  return url.href;
}

export type FilehostOptions = {
  account: string;
  password: string;
  /** PEM of the private CA that also verifies the IRC server. */
  ca?: string;
  timeoutMs?: number;
};

/**
 * Downloads and uploads on one FILEHOST. Every request goes only to the
 * current FILEHOST origin, with Basic credentials, redirects refused, a
 * timeout and the attachment size limits. Errors are generic: they never
 * carry URLs, headers or credentials.
 */
export class Filehost {
  public constructor(
    private readonly url: () => URL | undefined,
    private readonly options: FilehostOptions,
  ) {}

  /** The current upload URL; throws when the server offers none. */
  private uploadURL(): URL {
    const url = this.url();

    if (!url) {
      throw new UploadRefused();
    }

    return url;
  }

  private init(
    signal: AbortSignal,
    headers: Record<string, string> = {},
  ): RequestInit {
    const authorization = `Basic ${Buffer.from(
      `${this.options.account}:${this.options.password}`,
    ).toString("base64")}`;

    return {
      headers: { ...headers, authorization },
      redirect: "error",
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      ]),
      ...(this.options.ca && { tls: { ca: this.options.ca } }),
    };
  }

  /** True when `value` is a file URL on the current FILEHOST origin. */
  public owns(value: string) {
    const host = this.url();

    if (!host || !URL.canParse(value)) {
      return false;
    }

    return safeFileURL(new URL(value), host);
  }

  public async download(
    urls: readonly string[],
    signal: AbortSignal,
  ): Promise<Attachment[]> {
    if (urls.length > maxAttachments) {
      throw new Error("Too many attachments");
    }

    const files: Attachment[] = [];
    let total = 0;

    for (const value of urls) {
      if (!this.owns(value)) {
        throw new Error("File is not on the FILEHOST");
      }

      const url = new URL(value);
      let response: Response;

      try {
        response = await fetch(url, this.init(signal));
      } catch {
        signal.throwIfAborted();
        throw new Error("FILEHOST download failed");
      }

      try {
        if (response.status !== 200) {
          throw new Error("FILEHOST download failed");
        }

        const declared = response.headers.get("content-length");

        if (declared !== null && Number(declared) > maxAttachmentBytes) {
          throw new Error("FILEHOST file too large");
        }

        const data = await readBounded(response, maxAttachmentBytes, signal);
        total += data.byteLength;

        if (total > maxAttachmentTotalBytes) {
          throw new Error("FILEHOST files too large");
        }

        files.push({
          name: fileName(response.headers.get("content-disposition"), url),
          mime: safeAttachmentMime(response.headers.get("content-type"), data),
          data,
          source: { id: url.href },
        });
      } finally {
        await response.body?.cancel().catch(() => {});
      }
    }

    checkAttachments(files);

    return files;
  }

  /**
   * POST one file; resolves to the absolute file URL from Location. Rejects
   * with UploadRefused only for a proven refusal (`refusedStatuses`) or
   * when there is no FILEHOST; a 5xx or other answer, a lost response, a
   * timeout or a 201 without a usable Location may leave a stored file,
   * so those rejections are uncertain and the caller never repeats them.
   */
  public async upload(file: Attachment, signal: AbortSignal): Promise<string> {
    const target = this.uploadURL();
    let response: Response;

    try {
      response = await fetch(target, {
        ...this.init(signal, {
          "content-type": file.mime,
          "content-disposition": uploadDisposition(file.name),
        }),
        method: "POST",
        body: new Uint8Array(file.data),
      });
    } catch {
      signal.throwIfAborted();
      throw new Error("FILEHOST upload failed");
    }

    try {
      return uploadedLocation(response, target);
    } finally {
      await response.body?.cancel().catch(() => {});
    }
  }
}
