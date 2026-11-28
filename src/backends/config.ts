import { Schema } from "effect";
import {
  absolutePath,
  envName,
  settingsCheck,
  settingsDefault,
  settingsDiscriminatedUnion,
  settingsPattern,
  settingsRecord,
  settingsRefine,
  settingsStruct,
} from "../config/settings-schema";
import { claudeBackendSchema } from "./claude/config";
import { codexBackendSchema } from "./codex/config";
import { opencodeBackendSchema } from "./opencode/config";
import { piDurableBackendSchema } from "./pi/config";

/**
 * Tool-permission policy for ACP and Antigravity backends.
 *
 * - `deny` (default): fail closed; every ACP `session/request_permission`
 *   request is rejected.
 * - `workspace-write`: allow read/search tool calls and edits/writes strictly
 *   contained within canonical `directory` and `extraRoots`; deny commands,
 *   unknown paths and outside-root writes.
 * - `allow-all`: approve requests with `allow_once` (never `allow_always`).
 */
export const acpPermissionPolicySchema = Schema.Literals([
  "deny",
  "workspace-write",
  "allow-all",
]);

export type AcpPermissionPolicy = typeof acpPermissionPolicySchema.Type;

export const acpFlavorSchema = Schema.Literals(["generic", "copilot"]);

export type AcpFlavor = typeof acpFlavorSchema.Type;

export const acpResumeMethodSchema = Schema.Literals([
  "load",
  "resume",
  "none",
]);

export const acpCancelBehaviorSchema = Schema.Literals([
  "wait-for-prompt",
  "interrupt",
]);

const acpExtraRootsSchema = Schema.mutable(Schema.Array(absolutePath))
  .check(Schema.isMaxLength(16))
  .check(
    settingsRefine((roots) => new Set(roots).size === roots.length, {
      message: "Duplicate extraRoots entry",
    }),
  );

/**
 * Generic Agent Client Protocol (ACP) stdio backend. Runs an explicit
 * operator-configured ACP executable over JSON-RPC 2.0 stdio with a minimal
 * environment and fail-closed permission defaults.
 */
export const acpBackendSchema = settingsStruct({
  type: Schema.Literal("acp"),
  /** Starting working directory; not an OS sandbox. */
  directory: absolutePath,
  /** Absolute path to the ACP agent executable. */
  command: absolutePath,
  args: Schema.mutable(Schema.Array(Schema.String))
    .check(Schema.isMaxLength(64))
    .pipe(settingsDefault([])),
  /** Optional provider-specific flavor for ACP extensions (for example `copilot`). */
  flavor: acpFlavorSchema.pipe(settingsDefault("generic")),
  /** Optional model ID applied via ACP `model` config option or `session/set_model`. */
  model: Schema.optional(
    Schema.String.check(
      settingsPattern(/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/, {
        message: "Use a valid ACP model identifier",
      }),
    ),
  ),
  /** Optional reasoning / thinking level applied via ACP `thought_level` option. */
  reasoningEffort: Schema.optional(
    Schema.String.check(
      settingsPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, {
        message: "Use a valid reasoning effort identifier",
      }),
    ),
  ),
  /** Optional ACP session mode ID applied via `session/set_mode`. */
  mode: Schema.optional(
    Schema.String.check(
      settingsPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, {
        message: "Use a valid ACP mode identifier",
      }),
    ),
  ),
  /** Optional ACP `authenticate` method ID. */
  authMethodId: Schema.optional(
    Schema.String.check(
      settingsPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, {
        message: "Use a valid ACP authMethodId",
      }),
    ),
  ),
  permissionPolicy: acpPermissionPolicySchema.pipe(settingsDefault("deny")),
  extraRoots: acpExtraRootsSchema.pipe(settingsDefault([])),
  resumeMethod: acpResumeMethodSchema.pipe(settingsDefault("load")),
  cancelBehavior: acpCancelBehaviorSchema.pipe(
    settingsDefault("wait-for-prompt"),
  ),
  /** Non-secret literal environment variables passed to the ACP process. */
  env: settingsRecord(envName, Schema.String).pipe(settingsDefault({})),
  /** Child variable name → host environment variable holding a secret value. */
  secretEnv: settingsRecord(envName, envName).pipe(settingsDefault({})),
});

export type AcpBackendConfig = typeof acpBackendSchema.Type;

const gcpField = Schema.String.check(
  settingsPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, {
    message: "Use a valid GCP project or location identifier",
  }),
);

/**
 * Explicit Antigravity sign-in method; never holds secret values in JSON.
 * Ambient `GEMINI_API_KEY` / `GOOGLE_*` variables are stripped from the child
 * environment unless explicitly selected here.
 */
export const antigravityAuthSchema = settingsDiscriminatedUnion("method", [
  settingsStruct({
    method: Schema.Literal("gemini-api-key"),
    apiKeyEnv: envName,
  }),
  settingsStruct({
    method: Schema.Literal("agent-platform"),
    apiKeyEnv: Schema.optional(envName),
    gcpProject: Schema.optional(gcpField),
    gcpLocation: Schema.optional(gcpField),
  }).check(
    settingsCheck((value, context) => {
      const hasGcp =
        value.gcpProject !== undefined && value.gcpLocation !== undefined;

      if (value.apiKeyEnv === undefined && !hasGcp) {
        context.addIssue({
          code: "custom",
          message:
            "agent-platform auth requires apiKeyEnv or both gcpProject and gcpLocation",
        });
      }
    }),
  ),
  settingsStruct({
    method: Schema.Literal("oauth-personal"),
  }),
  settingsStruct({
    method: Schema.Literal("oauth-business"),
    gcpProject: gcpField,
    gcpLocation: gcpField,
  }),
]);

export type AntigravityAuthConfig = typeof antigravityAuthSchema.Type;

/**
 * Google Antigravity ACP backend (`agy acp` >= 1.5.1). Runs `agy acp` with an
 * isolated private `GEMINI_HOME`, browser suppression, telemetry disabled by
 * default, sandbox enabled by default, and fail-closed permission defaults.
 */
export const antigravityBackendSchema = settingsStruct({
  type: Schema.Literal("antigravity"),
  /** Starting working directory; not an OS sandbox on its own. */
  directory: absolutePath,
  /** Absolute path to the `agy` executable. */
  executable: absolutePath,
  /** Optional model ID available on the configured Antigravity account. */
  model: Schema.optional(
    Schema.String.check(
      settingsPattern(/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/, {
        message: "Use a valid Antigravity model identifier",
      }),
    ),
  ),
  /** Optional thinking level applied via ACP `thought_level` config option. */
  thinkingLevel: Schema.optional(
    Schema.String.check(
      settingsPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, {
        message: "Use a valid Antigravity thinking level",
      }),
    ),
  ),
  /** Appended to Antigravity's system prompt via ACP `_meta` when supported. */
  systemPrompt: Schema.optional(
    Schema.Trim.check(Schema.isMinCodePoints(1)).check(
      Schema.isMaxCodePoints(64_000),
    ),
  ),
  auth: antigravityAuthSchema,
  permissionPolicy: acpPermissionPolicySchema.pipe(settingsDefault("deny")),
  /** Pass `--sandbox` to `agy acp`; enabled by default. */
  sandbox: Schema.Boolean.pipe(settingsDefault(true)),
  /** Pass `--disable-telemetry` to `agy acp`; enabled by default. */
  disableTelemetry: Schema.Boolean.pipe(settingsDefault(true)),
  extraRoots: acpExtraRootsSchema.pipe(settingsDefault([])),
});

export type AntigravityBackendConfig = typeof antigravityBackendSchema.Type;

export const backendSchema = settingsDiscriminatedUnion("type", [
  opencodeBackendSchema,
  piDurableBackendSchema,
  claudeBackendSchema,
  codexBackendSchema,
  acpBackendSchema,
  antigravityBackendSchema,
  settingsStruct({
    type: Schema.Literal("module"),
    module: absolutePath,
    options: settingsRecord(Schema.String, Schema.Unknown).pipe(
      settingsDefault({}),
    ),
  }),
]);

export type BackendConfig = typeof backendSchema.Type;
