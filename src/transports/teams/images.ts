// Image framing and bounds adapted from Starfleet Teams. File access remains
// In Stargate's existing prepared-attachment boundary; this module never reads
// Paths or fetches URLs. Oversize static images are decoded within a pixel limit.
import { crc32 } from "node:zlib";
import type {
  AttachmentTransport,
  LinkTransport,
} from "../../chat/attachments/attachment-delivery";
import {
  type Attachment,
  UploadRefused,
} from "../../chat/attachments/attachments";
import type { OutgoingActivity } from "./connector";
import { TEAMS_SAFE_MESSAGE_BYTES } from "./teams";

export const MAX_IMAGE_BYTES = 1_000_000;
export const MAX_IMAGE_DIMENSION = 1024;
export const MAX_IMAGE_CAPTION = 7000;

export const SMALLER_IMAGE_HINT =
  "Use a smaller JPEG or crop the screenshot, and shorten its caption.";

export type Screenshot = {
  bytes: Buffer;
  contentType: "image/png" | "image/jpeg";
  width: number;
  height: number;
};

function dimensions(width: number, height: number, limit: number): void {
  if (!width || !height || width > limit || height > limit) {
    throw new Error(
      `screenshot dimensions must be between 1 and ${limit} pixels in each direction`,
    );
  }
}

function png(bytes: Buffer, limit: number): Omit<Screenshot, "bytes"> {
  let offset = 8;
  let width = 0;
  let height = 0;
  let imageData = false;

  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    const end = offset + 12 + size;

    if (end > bytes.length) {
      throw new Error("PNG screenshot is truncated");
    }

    const type = bytes.toString("latin1", offset + 4, offset + 8);

    if (!/^[A-Za-z]{4}$/.test(type)) {
      throw new Error("PNG screenshot has an invalid chunk");
    }

    if (
      bytes.readUInt32BE(end - 4) !== crc32(bytes.subarray(offset + 4, end - 4))
    ) {
      throw new Error("PNG screenshot has a damaged chunk");
    }

    if (offset === 8) {
      if (type !== "IHDR" || size !== 13) {
        throw new Error("PNG screenshot has no valid header");
      }

      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      dimensions(width, height, limit);

      const depths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };

      if (
        !depths[bytes[offset + 17] ?? -1]?.includes(bytes[offset + 16] ?? -1) ||
        bytes[offset + 18] !== 0 ||
        bytes[offset + 19] !== 0 ||
        (bytes[offset + 20] ?? 2) > 1
      ) {
        throw new Error("PNG screenshot has an unsupported header");
      }
    } else if (type === "IHDR") {
      throw new Error("PNG screenshot has more than one header");
    }

    if (type === "acTL" || type === "fcTL" || type === "fdAT") {
      throw new Error("animated PNG screenshots are not supported");
    }

    if (type === "IDAT" && size) {
      imageData = true;
    }

    if (type === "IEND") {
      if (size || end !== bytes.length || !imageData) {
        throw new Error("PNG screenshot has no complete image");
      }

      return { contentType: "image/png", width, height };
    }

    offset = end;
  }

  throw new Error("PNG screenshot is truncated");
}

function jpeg(bytes: Buffer, limit: number): Omit<Screenshot, "bytes"> {
  let offset = 2;
  let width = 0;
  let height = 0;
  let scan = false;
  let entropy = false;
  let scanData = false;

  while (offset < bytes.length) {
    if (entropy) {
      while (offset < bytes.length && bytes[offset] !== 0xff) {
        offset++;
        scanData = true;
      }
    }

    if (bytes[offset++] !== 0xff) {
      throw new Error("JPEG screenshot has an invalid marker");
    }

    while (bytes[offset] === 0xff) {
      offset++;
    }

    const marker = bytes[offset++];

    if (marker === undefined) {
      throw new Error("JPEG screenshot is truncated");
    }

    if (entropy && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) {
      scanData = true;
      continue;
    }

    entropy = false;

    if (marker === 0xd9) {
      if (offset !== bytes.length || !width || !scan || !scanData) {
        throw new Error("JPEG screenshot has no complete image");
      }

      return { contentType: "image/jpeg", width, height };
    }

    if (marker === 0xd8 || marker === 0 || offset + 2 > bytes.length) {
      throw new Error("JPEG screenshot is truncated or malformed");
    }

    const size = bytes.readUInt16BE(offset);

    if (size < 2 || offset + size > bytes.length) {
      throw new Error("JPEG screenshot has a truncated segment");
    }

    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      const components = bytes[offset + 7] ?? 0;

      if (
        width ||
        size < 11 ||
        bytes[offset + 2] !== 8 ||
        ![1, 3, 4].includes(components) ||
        size !== 8 + components * 3
      ) {
        throw new Error("JPEG screenshot has an unsupported frame");
      }

      height = bytes.readUInt16BE(offset + 3);
      width = bytes.readUInt16BE(offset + 5);
      dimensions(width, height, limit);
    } else if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      throw new Error("JPEG screenshot has an unsupported frame");
    }

    if (marker === 0xda) {
      const components = bytes[offset + 2] ?? 0;

      if (
        !width ||
        !components ||
        components > 4 ||
        size !== 6 + components * 2
      ) {
        throw new Error("JPEG screenshot has an invalid scan header");
      }

      scan = true;
      entropy = true;
    }

    offset += size;
  }

  throw new Error("JPEG screenshot is truncated");
}

export function inspectScreenshot(
  bytes: Buffer,
  maxDimension = MAX_IMAGE_DIMENSION,
  maxBytes = MAX_IMAGE_BYTES,
): Screenshot {
  if (bytes.length === 0 || bytes.length > maxBytes) {
    throw new Error(
      `screenshot must contain at most ${maxBytes} bytes. ${SMALLER_IMAGE_HINT}`,
    );
  }

  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return { bytes, ...png(bytes, maxDimension) };
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return { bytes, ...jpeg(bytes, maxDimension) };
  }

  throw new Error("screenshot must have a PNG or JPEG signature");
}

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_SOURCE_EDGE = 4096;
const MAX_PREVIEW_BYTES = 22_000;
let activePreviews = 0;

/** Validate original PNG/JPEG framing before allowing pass-through. Other formats always become still previews. */
async function inlineScreenshot(
  file: Attachment,
  signal: AbortSignal,
): Promise<Screenshot> {
  signal.throwIfAborted();

  if (!file.data.byteLength || file.data.byteLength > MAX_SOURCE_BYTES) {
    throw new Error("Teams screenshot source must contain 1 byte to 10 MiB");
  }

  const bytes = Buffer.from(
    file.data.buffer,
    file.data.byteOffset,
    file.data.byteLength,
  );

  if (file.mime === "image/png" || file.mime === "image/jpeg") {
    const original = inspectScreenshot(
      bytes,
      MAX_SOURCE_EDGE,
      MAX_SOURCE_BYTES,
    );

    if (original.contentType !== file.mime) {
      throw new Error("Teams screenshot MIME mismatch");
    }

    if (
      original.width <= MAX_IMAGE_DIMENSION &&
      original.height <= MAX_IMAGE_DIMENSION &&
      bytes.length <= MAX_PREVIEW_BYTES
    ) {
      return original;
    }
  } else if (file.mime !== "image/webp" && file.mime !== "image/gif") {
    throw new Error("Teams screenshots support PNG, JPEG, WebP and GIF");
  }

  // The WebP extended header reserves bit 1 for animation.
  if (
    file.mime === "image/webp" &&
    bytes.length >= 30 &&
    bytes.toString("ascii", 8, 16) === "WEBPVP8X" &&
    ((bytes[20] ?? 0) & 2) !== 0
  ) {
    throw new Error("Animated WebP screenshots are not supported");
  }

  // Cap native decoder memory across registrations in this gateway process.
  if (activePreviews >= 2) {
    throw new UploadRefused();
  }

  activePreviews++;

  try {
    const source = new Bun.Image(bytes, { maxPixels: MAX_SOURCE_EDGE ** 2 });
    const info = await source.metadata();

    if (`image/${info.format}` !== file.mime) {
      throw new Error("Teams screenshot MIME mismatch");
    }

    dimensions(info.width, info.height, MAX_SOURCE_EDGE);
    let image = source;

    for (const edge of [1024, 768, 512, 384, 256]) {
      signal.throwIfAborted();

      const preview = await image
        .resize(edge, edge, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 74 })
        .bytes();

      signal.throwIfAborted();

      if (preview.byteLength <= MAX_PREVIEW_BYTES) {
        return inspectScreenshot(Buffer.from(preview));
      }

      // Only the first pass decodes the full-size source.
      image = new Bun.Image(preview, { maxPixels: MAX_IMAGE_DIMENSION ** 2 });
    }

    throw new Error(SMALLER_IMAGE_HINT);
  } finally {
    activePreviews--;
  }
}

/** Count the final JSON, including reply metadata, in UTF-8 and UTF-16. */
export function screenshotActivity(
  image: Screenshot,
  caption = "",
  replyToId?: string,
): OutgoingActivity {
  if (caption.length > MAX_IMAGE_CAPTION) {
    throw new Error(
      `image caption must be at most ${MAX_IMAGE_CAPTION} characters`,
    );
  }

  const activity: OutgoingActivity = {
    type: "message",
    ...(caption && { text: caption, textFormat: "markdown" as const }),
    ...(replyToId && { replyToId }),
    attachments: [
      {
        contentType: image.contentType,
        contentUrl: `data:${image.contentType};base64,${image.bytes.toString("base64")}`,
        name:
          image.contentType === "image/png"
            ? "screenshot.png"
            : "screenshot.jpg",
      },
    ],
  };

  const json = JSON.stringify(activity);

  if (
    Math.max(Buffer.byteLength(json, "utf8"), json.length * 2) >
    TEAMS_SAFE_MESSAGE_BYTES
  ) {
    throw new Error(
      `encoded screenshot and caption exceed the Teams message budget. ${SMALLER_IMAGE_HINT}`,
    );
  }

  return activity;
}

const maxReceiptLength = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 32;

function screenshotReceipt(receipt: string): Screenshot {
  if (receipt.length > maxReceiptLength) {
    throw new Error("Teams image receipt exceeds the image limit");
  }

  const match =
    /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(receipt);

  if (!match?.[1] || !match[2]) {
    throw new Error("Teams image receipt is not a local PNG or JPEG");
  }

  const bytes = Buffer.from(match[2], "base64");

  if (bytes.toString("base64") !== match[2]) {
    throw new Error("Teams image receipt has invalid encoding");
  }

  const image = inspectScreenshot(bytes);

  if (image.contentType !== match[1]) {
    throw new Error("Teams image receipt MIME does not match its bytes");
  }

  return image;
}

export type SendTeamsImage = (
  channel: string,
  thread: string,
  activity: OutgoingActivity,
  signal: AbortSignal,
  allowed?: () => boolean,
) => Promise<unknown>;

/**
 * Upload encodes already-prepared bytes only. The receipt stays in private
 * SQLite delivery state. link is the sole publication step and is one-shot:
 * the core records completing first and never replays an uncertain publish.
 */
export function teamsImageTransport(
  send: SendTeamsImage,
  download?: AttachmentTransport["download"],
): AttachmentTransport & LinkTransport & { publishOnce: true } {
  return {
    publishOnce: true,
    async download(ids, channel, signal) {
      if (download) {
        return download(ids, channel, signal);
      }

      signal.throwIfAborted();
      throw new Error("Teams inbound attachment downloads are not supported");
    },
    async upload(file: Attachment, signal) {
      signal.throwIfAborted();

      const image = await inlineScreenshot(file, signal);
      const activity = screenshotActivity(image);
      const receipt = activity.attachments?.[0]?.contentUrl;

      if (!receipt) {
        throw new Error("Teams screenshot encoding failed");
      }

      signal.throwIfAborted();

      return receipt;
    },
    async link(channel, thread, receipt, title, signal, allowed) {
      signal.throwIfAborted();

      if (allowed && !allowed()) {
        throw new Error("Teams image delivery access denied");
      }

      const activity = screenshotActivity(
        screenshotReceipt(receipt),
        title,
        thread,
      );

      signal.throwIfAborted();

      if (allowed && !allowed()) {
        throw new Error("Teams image delivery access denied");
      }

      try {
        await send(channel, thread, activity, signal, allowed);
        signal.throwIfAborted();
      } catch {
        throw new Error(
          "Teams image delivery is unconfirmed; the image will not be resent automatically",
        );
      }
    },
  };
}
