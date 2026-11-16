// Image framing and bounds adapted from Starfleet Teams. File access remains
// in Stargate's existing prepared-attachment boundary; this module never reads
// paths, fetches URLs or invokes an image decoder.
import type {
  AttachmentTransport,
  LinkTransport,
} from "../attachment-delivery";
import type { Attachment } from "../attachments";
import type { OutgoingActivity } from "./connector";
import { TEAMS_SAFE_MESSAGE_BYTES } from "./teams";

export const MAX_IMAGE_BYTES = 1_000_000;
export const MAX_IMAGE_DIMENSION = 1_024;
export const MAX_IMAGE_CAPTION = 7_000;
export const SMALLER_IMAGE_HINT =
  "Use a smaller JPEG or crop the screenshot, and shorten its caption.";

export type Screenshot = {
  bytes: Buffer;
  contentType: "image/png" | "image/jpeg";
  width: number;
  height: number;
};

function dimensions(width: number, height: number): void {
  if (
    !width ||
    !height ||
    width > MAX_IMAGE_DIMENSION ||
    height > MAX_IMAGE_DIMENSION
  ) {
    throw new Error(
      `screenshot dimensions must be between 1 and ${MAX_IMAGE_DIMENSION} pixels in each direction`,
    );
  }
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(bytes: Buffer): Omit<Screenshot, "bytes"> {
  let offset = 8;
  let width = 0;
  let height = 0;
  let imageData = false;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    const end = offset + 12 + size;
    if (end > bytes.length) throw new Error("PNG screenshot is truncated");
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type))
      throw new Error("PNG screenshot has an invalid chunk");
    if (
      bytes.readUInt32BE(end - 4) !== crc32(bytes.subarray(offset + 4, end - 4))
    )
      throw new Error("PNG screenshot has a damaged chunk");
    if (offset === 8) {
      if (type !== "IHDR" || size !== 13)
        throw new Error("PNG screenshot has no valid header");
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      dimensions(width, height);
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
    } else if (type === "IHDR")
      throw new Error("PNG screenshot has more than one header");
    if (type === "acTL" || type === "fcTL" || type === "fdAT")
      throw new Error("animated PNG screenshots are not supported");
    if (type === "IDAT" && size) imageData = true;
    if (type === "IEND") {
      if (size || end !== bytes.length || !imageData)
        throw new Error("PNG screenshot has no complete image");
      return { contentType: "image/png", width, height };
    }
    offset = end;
  }
  throw new Error("PNG screenshot is truncated");
}

function jpeg(bytes: Buffer): Omit<Screenshot, "bytes"> {
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
    if (bytes[offset++] !== 0xff)
      throw new Error("JPEG screenshot has an invalid marker");
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined) throw new Error("JPEG screenshot is truncated");
    if (entropy && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) {
      scanData = true;
      continue;
    }
    entropy = false;
    if (marker === 0xd9) {
      if (offset !== bytes.length || !width || !scan || !scanData)
        throw new Error("JPEG screenshot has no complete image");
      return { contentType: "image/jpeg", width, height };
    }
    if (marker === 0xd8 || marker === 0 || offset + 2 > bytes.length)
      throw new Error("JPEG screenshot is truncated or malformed");
    const size = bytes.readUInt16BE(offset);
    if (size < 2 || offset + size > bytes.length)
      throw new Error("JPEG screenshot has a truncated segment");
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      const components = bytes[offset + 7] ?? 0;
      if (
        width ||
        size < 11 ||
        bytes[offset + 2] !== 8 ||
        ![1, 3, 4].includes(components) ||
        size !== 8 + components * 3
      )
        throw new Error("JPEG screenshot has an unsupported frame");
      height = bytes.readUInt16BE(offset + 3);
      width = bytes.readUInt16BE(offset + 5);
      dimensions(width, height);
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
      )
        throw new Error("JPEG screenshot has an invalid scan header");
      scan = true;
      entropy = true;
    }
    offset += size;
  }
  throw new Error("JPEG screenshot is truncated");
}

export function inspectScreenshot(bytes: Buffer): Screenshot {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
    throw new Error(
      `screenshot must contain at most ${MAX_IMAGE_BYTES} bytes. ${SMALLER_IMAGE_HINT}`,
    );
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { bytes, ...png(bytes) };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { bytes, ...jpeg(bytes) };
  throw new Error("screenshot must have a PNG or JPEG signature");
}

/** Count the final JSON, including reply metadata, in UTF-8 and UTF-16. */
export function screenshotActivity(
  image: Screenshot,
  caption = "",
  replyToId?: string,
): OutgoingActivity {
  if (caption.length > MAX_IMAGE_CAPTION)
    throw new Error(
      `image caption must be at most ${MAX_IMAGE_CAPTION} characters`,
    );
  const activity: OutgoingActivity = {
    type: "message",
    ...(caption ? { text: caption, textFormat: "markdown" as const } : {}),
    ...(replyToId ? { replyToId } : {}),
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
  )
    throw new Error(
      `encoded screenshot and caption exceed the Teams message budget. ${SMALLER_IMAGE_HINT}`,
    );
  return activity;
}

const maxReceiptLength = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 32;
function screenshotReceipt(receipt: string): Screenshot {
  if (receipt.length > maxReceiptLength)
    throw new Error("Teams image receipt exceeds the image limit");
  const match =
    /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(receipt);
  if (!match?.[1] || !match[2])
    throw new Error("Teams image receipt is not a local PNG or JPEG");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.toString("base64") !== match[2])
    throw new Error("Teams image receipt has invalid encoding");
  const image = inspectScreenshot(bytes);
  if (image.contentType !== match[1])
    throw new Error("Teams image receipt MIME does not match its bytes");
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
): AttachmentTransport & LinkTransport & { publishOnce: true } {
  return {
    publishOnce: true,
    async download(_ids, _channel, signal) {
      signal.throwIfAborted();
      throw new Error("Teams inbound attachment downloads are not supported");
    },
    async upload(file: Attachment, signal) {
      signal.throwIfAborted();
      if (file.data.byteLength > MAX_IMAGE_BYTES)
        throw new Error(
          `screenshot must contain at most ${MAX_IMAGE_BYTES} bytes. ${SMALLER_IMAGE_HINT}`,
        );
      const image = inspectScreenshot(Buffer.from(file.data));
      if (file.mime !== image.contentType)
        throw new Error(
          "Teams screenshot MIME does not match its PNG or JPEG bytes",
        );
      const activity = screenshotActivity(image);
      const receipt = activity.attachments?.[0]?.contentUrl;
      if (!receipt) throw new Error("Teams screenshot encoding failed");
      signal.throwIfAborted();
      return receipt;
    },
    async link(channel, thread, receipt, title, signal, allowed) {
      signal.throwIfAborted();
      if (allowed && !allowed())
        throw new Error("Teams image delivery access denied");
      const activity = screenshotActivity(
        screenshotReceipt(receipt),
        title,
        thread,
      );
      signal.throwIfAborted();
      if (allowed && !allowed())
        throw new Error("Teams image delivery access denied");
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
