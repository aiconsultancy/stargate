import { Schema } from "effect";
import {
  absolutePath,
  settingsDefault,
  settingsDiscriminatedUnion,
  settingsRecord,
  settingsStruct,
} from "../config/settings-schema";
import { claudeBackendSchema } from "./claude/config";
import { codexBackendSchema } from "./codex/config";
import { opencodeBackendSchema } from "./opencode/config";
import { piDurableBackendSchema } from "./pi/config";

export const backendSchema = settingsDiscriminatedUnion("type", [
  opencodeBackendSchema,
  piDurableBackendSchema,
  claudeBackendSchema,
  codexBackendSchema,
  settingsStruct({
    type: Schema.Literal("module"),
    module: absolutePath,
    options: settingsRecord(Schema.String, Schema.Unknown).pipe(
      settingsDefault({}),
    ),
  }),
]);

export type BackendConfig = typeof backendSchema.Type;
