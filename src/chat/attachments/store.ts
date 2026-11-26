import type { Database } from "bun:sqlite";
import { Schema } from "effect";
import { settingsPattern } from "../../config/settings-schema";
import {
  type PreparedAttachment,
  type PublishedFile,
  chatUploadReferenceSource,
} from "./attachments";

export type AttachmentDelivery = PublishedFile & {
  title?: string;
  prepared?: PreparedAttachment;
  phase?:
    | "reserved"
    | "uploading"
    | "uploaded"
    | "completing"
    | "shared"
    | "unavailable";
  fileID?: string;
  noticeSent?: boolean;
};

// Slack file IDs, IRC FILEHOST URLs or Subspace chat references.
const decodeInputFiles = Schema.decodeUnknownSync(
  Schema.mutable(
    Schema.Array(
      Schema.String.check(
        Schema.isMaxCodePoints(2048),
        settingsPattern(
          new RegExp(
            String.raw`^(?:teams:image-unavailable|teams:document(?:-unavailable|:[a-f0-9-]{36})|F[A-Z0-9]+|https?://\S+|${chatUploadReferenceSource})$`,
            "u",
          ),
        ),
      ),
    ),
  ).check(Schema.isMaxLength(10)),
);

export class AttachmentRecords {
  public constructor(private readonly db: Database) {}

  public inputFiles(id: number): string[] {
    const row = this.db
      .query<{ input_files: string | null }, [number]>(
        "SELECT input_files FROM jobs WHERE id=?",
      )
      .get(id);

    return row?.input_files
      ? decodeInputFiles(JSON.parse(row.input_files))
      : [];
  }

  public attachments(id: number): AttachmentDelivery[] {
    const row = this.db
      .query<{ output_files: string | null }, [number]>(
        "SELECT output_files FROM jobs WHERE id=?",
      )
      .get(id);

    return row?.output_files
      ? (JSON.parse(row.output_files) as AttachmentDelivery[])
      : [];
  }

  public saveAttachments(id: number, files: readonly AttachmentDelivery[]) {
    this.db
      .query("UPDATE jobs SET output_files=? WHERE id=?")
      .run(JSON.stringify(files), id);
  }
}
