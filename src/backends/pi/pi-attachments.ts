import type { UserInput } from "@earendil-works/pi-durable";
import {
  type Attachment,
  checkAttachments,
} from "../../chat/attachments/attachments";
import { AttachmentInputUnavailable } from "../../shared/request-failure";

/** Pi 1.5 has text/image user blocks, not PDF/document input blocks. */
export function piInputContent(
  text: string,
  files: readonly Attachment[],
  acceptsImages: boolean,
): UserInput {
  try {
    checkAttachments(files);
  } catch {
    throw new AttachmentInputUnavailable("Invalid or oversized Pi attachments");
  }

  if (files.length === 0) return text;
  const content: Exclude<UserInput, string> = [];

  if (text) content.push({ type: "text", text });

  for (const file of files) {
    if (
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.mime)
    ) {
      // Pi otherwise replaces unsupported images with a textual placeholder.
      if (!acceptsImages)
        throw new AttachmentInputUnavailable(
          "Pi model does not support images",
        );
      content.push(
        { type: "text", text: `Attachment: ${file.name}` },
        {
          type: "image",
          data: Buffer.from(file.data).toString("base64"),
          mimeType: file.mime,
        },
      );
    } else if (
      file.mime.startsWith("text/") ||
      [
        "application/json",
        "application/xml",
        "application/yaml",
        "application/javascript",
      ].includes(file.mime)
    ) {
      let decoded: string;

      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(file.data);
      } catch {
        throw new AttachmentInputUnavailable(
          "Pi text attachments require valid UTF-8",
        );
      }

      if (
        file.data.some(
          (byte) =>
            byte === 127 ||
            (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13),
        )
      )
        throw new AttachmentInputUnavailable(
          "Pi text attachment contains binary control bytes",
        );
      content.push({
        type: "text",
        text: `Attachment: ${file.name}\n${decoded}`,
      });
    } else {
      throw new AttachmentInputUnavailable(
        "Pi supports UTF-8 text and PNG/JPEG/GIF/WebP attachments only",
      );
    }
  }

  return content;
}
