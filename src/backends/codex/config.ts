import { Schema } from "effect";
import {
  absolutePath,
  piProviderSchema,
  settingsDefault,
  settingsPattern,
  settingsRefine,
  settingsStruct,
} from "../../config/settings-schema";

/**
 * Codex SDK backend. The model is reached only through the explicit proxy
 * `provider` (an OpenAI Responses API endpoint); there is no ChatGPT login,
 * `~/.codex` or API-key fallback. Only settings the Codex sandbox enforces
 * are accepted.
 */
export const codexBackendSchema = settingsStruct({
  type: Schema.Literal("codex"),
  /** Starting working directory and sandbox root, not a host boundary. */
  directory: absolutePath,
  model: Schema.String.check(
    settingsPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, {
      message: "Use a proxy model ID such as gpt-6.1-sol",
    }),
  ),
  /** OpenAI Responses API endpoint ending in `/v1`, as for OpenCode. */
  provider: piProviderSchema.check(
    settingsRefine((provider) => provider.baseURL.endsWith("/v1"), {
      message: "Codex provider baseURL must end with /v1",
    }),
  ),
  reasoningEffort: Schema.optional(
    Schema.Literals(["minimal", "low", "medium", "high", "xhigh"]),
  ),
  /** Added as Codex developer instructions. */
  systemPrompt: Schema.optional(
    Schema.Trim.check(Schema.isMinCodePoints(1)).check(
      Schema.isMaxCodePoints(64_000),
    ),
  ),
  /**
   * Codex sandbox for tool commands. `read-only` by default;
   * `workspace-write` permits writes under `directory`;
   * `danger-full-access` runs commands without a sandbox.
   */
  sandbox: Schema.Literals([
    "read-only",
    "workspace-write",
    "danger-full-access",
  ]).pipe(settingsDefault("read-only")),
  /**
   * Network for tool commands. Only `workspace-write` switches it; the
   * read-only sandbox always blocks it, and `danger-full-access` cannot
   * block it, so that mode requires `network: true`.
   */
  network: Schema.Boolean.pipe(settingsDefault(false)),
  /** Read `AGENTS.md` project instructions from `directory`. */
  projectDocs: Schema.Boolean.pipe(settingsDefault(false)),
  /**
   * Directories after the system ones on the CLI's `PATH`. The operator's
   * own `PATH` is never inherited; every entry is checked at start-up.
   */
  extraPath: Schema.mutable(Schema.Array(absolutePath))
    .check(Schema.isMaxLength(32))
    .pipe(settingsDefault([])),
})
  .check(
    settingsRefine(
      (backend) => !backend.network || backend.sandbox !== "read-only",
      {
        message:
          "The read-only sandbox always blocks network; network: true needs workspace-write",
      },
    ),
  )
  .check(
    settingsRefine(
      (backend) => backend.network || backend.sandbox !== "danger-full-access",
      {
        message:
          "danger-full-access cannot block the network; set network: true",
      },
    ),
  );
