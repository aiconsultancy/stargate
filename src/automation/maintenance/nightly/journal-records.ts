import { Schema } from "effect";
import {
  settingsDateTime,
  settingsPattern,
  settingsStruct,
} from "../../../config/settings-schema";
import { parseVersion } from "./update/versions";

/**
 * Record schemas of the maintenance undo journal (see journal.ts): the
 * version 2 entries, the version 1 record, the first version's marker and
 * the backup manifest entries. Schemas and their types only.
 */
export const journalV1 = "stargate.maintenance.journal.v1";

const pattern = (regex: RegExp) => Schema.String.check(settingsPattern(regex));

const version = Schema.String.check(
  Schema.makeFilter(
    (v: string) => /^\d+\.\d+\.\d+$/.test(v) && parseVersion(v) !== null,
  ),
);

const releaseName = pattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);

// Zod counted code points for `max`; keep that unit.
const npmName = pattern(
  /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/,
).check(Schema.isMaxCodePoints(214));

const iso = settingsDateTime;
const sessionID = pattern(/^ses_[A-Za-z0-9]{1,250}$/);
const modelPart = pattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/);

const modelRef = settingsStruct({
  providerID: pattern(/^[a-z0-9][a-z0-9_-]{0,99}$/),
  id: modelPart,
  variant: Schema.optional(modelPart),
});

// Zod's `z.uuid()` pattern, or the marker of the first journal format.
export const runIDSchema = Schema.Union([
  pattern(
    /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/,
  ),
  Schema.Literal("legacy"),
]);

const list = <S extends Schema.Top>(item: S) =>
  Schema.mutable(Schema.Array(item));

export const fields = {
  gateway: settingsStruct({ restartPending: Schema.Boolean }),
  cliproxyapi: settingsStruct({ previousVersion: version }),
  release: settingsStruct({ previous: releaseName, version }),
  files: settingsStruct({}),
  clis: settingsStruct({
    packages: list(
      settingsStruct({ name: npmName, before: version, cutoff: iso }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  }),
  sessions: list(settingsStruct({ id: sessionID, from: modelRef })).check(
    Schema.isMaxLength(5000),
  ),
  openCode: settingsStruct({
    /** OpenCode was (or may have been) restarted with the new state. */
    restarted: Schema.Boolean,
    /** An undo changed loaded state; a restart is owed. */
    restartPending: Schema.Boolean,
  }),
};

export type Fields = {
  [K in keyof typeof fields]?: (typeof fields)[K]["Type"];
};

export type SessionItem = (typeof fields.sessions.Type)[number];

/** Version 1 (first review round) carried commands and paths; only its data is kept. */
export const v1 = settingsStruct({
  schema: Schema.Literal(journalV1),
  runID: runIDSchema,
  gateway: Schema.optional(settingsStruct({ unit: Schema.String })),
  cliproxyapi: Schema.optional(
    settingsStruct({
      unit: Schema.String,
      link: Schema.String,
      previousTarget: Schema.String,
      version,
      url: Schema.String,
      clientKeyFile: Schema.String,
    }),
  ),
  release: Schema.optional(
    settingsStruct({ root: Schema.String, previous: releaseName, version }),
  ),
  files: Schema.optional(settingsStruct({ backup: Schema.String })),
  clis: Schema.optional(
    settingsStruct({
      npm: list(Schema.String),
      prefix: Schema.String,
      registry: Schema.String,
      allowScripts: list(Schema.String),
      lockFile: Schema.optional(Schema.String),
      packages: list(
        settingsStruct({
          name: npmName,
          command: Schema.String,
          before: version,
          cutoff: iso,
        }),
      ),
    }),
  ),
  sessions: Schema.optional(fields.sessions),
  openCode: Schema.optional(
    settingsStruct({ restart: list(Schema.String), restarted: Schema.Boolean }),
  ),
});

/** The first maintenance version wrote only this marker. */
export const legacyMarker = settingsStruct({
  unit: Schema.String,
  stargateRoot: Schema.optional(Schema.NullOr(Schema.String)),
  previousRelease: Schema.optional(Schema.NullOr(releaseName)),
});

export const backupEntry = Schema.Union([
  settingsStruct({
    kind: Schema.Literal("file"),
    path: Schema.String.check(
      Schema.isMinCodePoints(1),
      Schema.isMaxCodePoints(4096),
    ),
    old: Schema.NullOr(Schema.String),
    written: pattern(/^[a-f0-9]{64}$/),
  }),
  settingsStruct({
    kind: Schema.Literal("link"),
    path: Schema.String.check(
      Schema.isMinCodePoints(1),
      Schema.isMaxCodePoints(4096),
    ),
    target: Schema.String.check(
      Schema.isMinCodePoints(1),
      Schema.isMaxCodePoints(4096),
    ),
  }),
]);

export type BackupEntry = typeof backupEntry.Type;
