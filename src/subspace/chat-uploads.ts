import { createHash } from "node:crypto";
import { Schema } from "effect";
import {
  type ReadChatUpload,
  chatUploadReference,
  checkAttachments,
  maxAttachmentBytes,
  safeAttachmentMime,
} from "../chat/attachments/attachments";
import { readAll, socketRequest } from "./bridge";

const metadata = Schema.decodeUnknownSync(
  Schema.Struct({
    reference: Schema.String,
    fileName: Schema.String,
    contentType: Schema.String,
    sizeBytes: Schema.Int,
    sha256: Schema.String,
  }),
);

/** Take only fixed upload routes through the addressed officer's signing socket. */
export function chatUploadReader(socketPath: string): ReadChatUpload {
  return async (reference, caller) => {
    if (!chatUploadReference.test(reference)) {
      throw new Error("Invalid Subspace chat upload reference");
    }

    const signal = AbortSignal.any([caller, AbortSignal.timeout(30_000)]);
    const path = `/api/v1/chat/uploads/${reference}`;

    const get = async (target: string, limit: number) => {
      const reply = await socketRequest(
        socketPath,
        "GET",
        target,
        {},
        undefined,
        signal,
      );

      if (reply.status !== 200) {
        reply.body.destroy();
        throw new Error(
          `Subspace chat upload is unavailable (HTTP ${reply.status})`,
        );
      }

      return readAll(reply.body, limit);
    };

    const facts = metadata(
      JSON.parse((await get(path, 16_384)).toString("utf8")),
    );

    if (
      facts.reference !== reference ||
      facts.sizeBytes < 1 ||
      facts.sizeBytes > maxAttachmentBytes
    ) {
      throw new Error(
        "Subspace chat upload has invalid metadata or exceeds the size limit",
      );
    }

    const data = await get(`${path}/content`, facts.sizeBytes);

    if (
      data.byteLength !== facts.sizeBytes ||
      createHash("sha256").update(data).digest("hex") !== facts.sha256
    ) {
      throw new Error("Subspace chat upload did not match its metadata");
    }

    const file = {
      name: facts.fileName,
      mime: safeAttachmentMime(facts.contentType, data),
      data,
      source: { id: reference },
    };

    checkAttachments([file]);

    return file;
  };
}
