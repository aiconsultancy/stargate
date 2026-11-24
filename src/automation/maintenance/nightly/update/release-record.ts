import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import {
  settingsOffsetDatetime,
  settingsPattern,
  settingsStruct,
} from "../../../../config/settings-schema";
import { parseVersion } from "./versions";

export const metadataFile = ".stargate-release.json";

const releaseMetadataSchema = settingsStruct({
  schema: Schema.Literal("stargate.release.v1"),
  version: Schema.String.check(
    Schema.makeFilter((value) => parseVersion(value) !== null),
  ),
  tag: Schema.NullOr(Schema.String.check(Schema.isMaxCodePoints(100))),
  commit: Schema.NullOr(Schema.String.check(settingsPattern(/^[a-f0-9]{40}$/))),
  sha256: Schema.NullOr(Schema.String.check(settingsPattern(/^[a-f0-9]{64}$/))),
  installedAt: settingsOffsetDatetime,
  /** `verified`: downloaded and checked by maintenance. `adopted`: migrated. */
  verification: Schema.Literals(["verified", "adopted"]),
  tree: Schema.Literals(["equal", "not-configured", "adopted"]),
});

export type ReleaseMetadata = typeof releaseMetadataSchema.Type;

const decodeMetadata = Schema.decodeUnknownSync(releaseMetadataSchema);

export async function readMetadata(directory: string) {
  try {
    return decodeMetadata(
      JSON.parse(await readFile(join(directory, metadataFile), "utf8")),
    );
  } catch {
    return null;
  }
}
