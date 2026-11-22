import type { Database } from "bun:sqlite";
import { Schema } from "effect";
import { settingsPattern } from "../config/settings-schema";
import type { PreparedAttachment, PublishedFile } from "./attachments";

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

export class AttachmentRecords {
  constructor(private readonly db: Database) {}

  inputFiles(id: number): string[] {
    const row = this.db
      .query<{ input_files: string | null }, [number]>(
        "SELECT input_files FROM jobs WHERE id=?",
      )
      .get(id);

    return row?.input_files
      ? // Slack file IDs, or IRC FILEHOST URLs that the transport rechecks.
        Schema.decodeUnknownSync(
          Schema.mutable(
            Schema.Array(
              Schema.String.check(
                Schema.isMaxCodePoints(2048),
                settingsPattern(/^(?:F[A-Z0-9]+|https?:\/\/\S+)$/),
              ),
            ),
          ).check(Schema.isMaxLength(10)),
        )(JSON.parse(row.input_files))
      : [];
  }

  attachments(id: number): AttachmentDelivery[] {
    const row = this.db
      .query<{ output_files: string | null }, [number]>(
        "SELECT output_files FROM jobs WHERE id=?",
      )
      .get(id);

    return row?.output_files
      ? (JSON.parse(row.output_files) as AttachmentDelivery[])
      : [];
  }

  saveAttachments(id: number, files: readonly AttachmentDelivery[]) {
    this.db
      .query("UPDATE jobs SET output_files=? WHERE id=?")
      .run(JSON.stringify(files), id);
  }
}
