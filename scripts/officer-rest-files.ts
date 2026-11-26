import { createHash } from "node:crypto";
import { Schema } from "effect";

const sizeLimit = 10 * 1024 * 1024;

const metadata = Schema.Struct({
  fileName: Schema.String,
  sizeBytes: Schema.Int,
  sha256: Schema.String,
  id: Schema.optionalKey(Schema.String),
  mediaId: Schema.optionalKey(Schema.String),
});

const receipt = Schema.fromJsonString(
  Schema.Struct({ ...metadata.fields, reference: Schema.String }),
);

const readPage = Schema.fromJsonString(
  Schema.Struct({
    items: Schema.Array(metadata),
    nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
);

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export class RestFiles {
  public constructor(
    private readonly read: (path: string, limit: number) => Promise<Buffer>,
    private readonly safeName: (name: string) => string,
    private readonly uuid: (id: string) => string,
  ) {}

  private async content(file: typeof metadata.Type, path: string) {
    if (
      file.sizeBytes < 1 ||
      file.sizeBytes > sizeLimit ||
      !/^[a-f0-9]{64}$/i.test(file.sha256)
    ) {
      throw new Error("Invalid file metadata.");
    }

    const name = this.safeName(file.fileName);
    const data = await this.read(path, file.sizeBytes);

    if (
      data.length !== file.sizeBytes ||
      sha256(data) !== file.sha256.toLowerCase()
    ) {
      throw new Error("File bytes do not match verified metadata.");
    }

    return { name, data };
  }

  private async json(path: string) {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await this.read(path, 2 * 1024 * 1024),
    );
  }

  public async upload(reference: string) {
    const path = `/api/v1/chat/uploads/${reference}`;
    const file = Schema.decodeUnknownSync(receipt)(await this.json(path));

    if (file.reference !== reference) {
      throw new Error("The upload reference changed.");
    }

    return this.content(file, path + "/content");
  }

  public async attachment(issue: string, media: string) {
    if (!/^[A-Z][A-Z0-9]{0,18}-[1-9][0-9]{0,9}$/.test(issue)) {
      throw new Error("Invalid issue key.");
    }

    const id = this.uuid(media);

    for (const kind of ["attachments", "images"]) {
      const query = new URLSearchParams({ limit: "100" });

      for (let page = 0; page < 100; page++) {
        const value = Schema.decodeUnknownSync(readPage)(
          await this.json(`/api/v1/issues/${issue}/${kind}?${query}`),
        );

        const item = value.items.find(
          (file) => (file.mediaId ?? file.id) === id,
        );

        if (item) {
          const target = kind === "attachments" ? "attachments" : "media";

          return this.content(item, `/api/v1/issues/${target}/${id}`);
        }

        if (!value.nextCursor) {
          break;
        }

        query.set("cursor", value.nextCursor);
      }
    }

    throw new Error("Attachment absent from the configured issue.");
  }
}
