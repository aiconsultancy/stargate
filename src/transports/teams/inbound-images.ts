import {
  type Attachment,
  maxAttachmentBytes,
  maxAttachmentTotalBytes,
  maxAttachments,
} from "../../chat/attachments/attachments";
import { serviceUrlBase } from "./service-url";

type IncomingImage = {
  readonly contentType?: string | undefined;
  readonly contentUrl?: string | undefined;
};

/** Keep only authenticated Connector attachment views below this turn's service URL. */
export function imageView(service: string, value: string): string {
  const prefix = serviceUrlBase(service) + "/v3/attachments/";

  if (
    !value.startsWith(prefix) ||
    !/^[A-Za-z0-9_.:~+=-]{1,1536}\/views\/original$/.test(
      value.slice(prefix.length),
    ) ||
    new URL(value).href !== value
  ) {
    throw new Error("Invalid Teams image attachment address");
  }

  return value;
}

export function incomingImageRefs(
  service: string,
  attachments: readonly IncomingImage[] = [],
): string[] {
  const images = attachments.filter((item) =>
    item.contentType?.toLowerCase().startsWith("image/"),
  );

  if (images.length > maxAttachments) {
    return ["teams:image-unavailable"];
  }

  try {
    return images.map((item) => imageView(service, item.contentUrl ?? ""));
  } catch {
    return ["teams:image-unavailable"];
  }
}

async function readImage(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");

  if (
    response.status !== 200 ||
    !response.body ||
    (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit))
  ) {
    await response.body?.cancel();
    throw new Error("Teams image download unavailable or too large");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      total += chunk.value.length;

      if (total > limit) {
        throw new Error("Teams image exceeds the file size limit");
      }

      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  if (
    !total ||
    (declared !== null &&
      !response.headers.has("content-encoding") &&
      total !== Number(declared))
  ) {
    throw new Error("Incomplete Teams image");
  }

  return Buffer.concat(chunks, total);
}

export async function downloadImages(
  service: string,
  refs: readonly string[],
  signal: AbortSignal,
  fetchImage: (url: string, signal: AbortSignal) => Promise<Response>,
): Promise<Attachment[]> {
  if (refs.length > maxAttachments) {
    throw new Error("Too many Teams images");
  }

  const files: Attachment[] = [];
  let remaining = maxAttachmentTotalBytes;

  for (const ref of refs) {
    signal.throwIfAborted();
    const response = await fetchImage(imageView(service, ref), signal);

    const data = await readImage(
      response,
      Math.min(maxAttachmentBytes, remaining),
      signal,
    );

    const info = await new Bun.Image(data, { maxPixels: 4096 ** 2 }).metadata();

    if (
      !["jpeg", "png", "webp", "gif"].includes(info.format) ||
      info.width > 4096 ||
      info.height > 4096
    ) {
      throw new Error("Unsupported Teams image");
    }

    const mime = "image/" + info.format;

    const declaredType = response.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();

    if (
      declaredType &&
      declaredType !== "application/octet-stream" &&
      declaredType !== "image/*" &&
      declaredType !== mime
    ) {
      throw new Error("Teams image content type mismatch");
    }

    signal.throwIfAborted();
    files.push({
      name: `screenshot-${files.length + 1}.${info.format}`,
      mime,
      data,
      source: { id: ref },
    });
    remaining -= data.byteLength;
  }

  return files;
}
