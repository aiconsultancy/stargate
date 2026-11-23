import { Schema } from "effect";
import {
  absolutePath,
  piProviderSchema,
  secureLocalOrHttpsURL,
  settingsDefault,
  settingsDiscriminatedUnion,
  settingsPattern,
  settingsRecord,
  settingsRefine,
  settingsStruct,
} from "../../config/settings-schema";

/**
 * Built-in Claude Code tools that a `claude` backend may enable. Others, such
 * as scheduling, notification or plan-mode tools, need a reviewed change.
 * Tests check that the pinned SDK still defines every name.
 */
export const claudeToolNames = [
  "Agent",
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "LSP",
  "NotebookEdit",
  "Read",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Write",
] as const;

/**
 * Bare tool names only. A scoped rule such as `Read(./src/**)` is refused:
 * Claude Code permits reads anywhere in its working directory regardless of
 * the scope, so the rule would promise a limit that nothing enforces.
 */
const claudeToolsSchema = Schema.mutable(
  Schema.Array(Schema.Literals(claudeToolNames)),
)
  .check(Schema.isMaxLength(claudeToolNames.length))
  .check(
    settingsRefine((tools) => new Set(tools).size === tools.length, {
      message: "Duplicate allowedTools entry",
    }),
  );

/** Explicit, operator-controlled MCP servers; no embedded credentials. */
const claudeMcpServersSchema = settingsRecord(
  Schema.String.check(settingsPattern(/^[a-z][a-z0-9_-]{0,31}$/)),
  settingsDiscriminatedUnion("type", [
    settingsStruct({
      type: Schema.Literal("http"),
      url: secureLocalOrHttpsURL,
      headersHelper: Schema.optional(
        Schema.String.check(
          settingsPattern(/^\/[a-zA-Z0-9_./-]+(?: [a-zA-Z0-9_./-]+)*$/, {
            message:
              "Use an absolute executable and optional literal arguments",
          }),
        ),
      ),
    }),
    settingsStruct({
      type: Schema.Literal("stdio"),
      command: absolutePath,
      args: Schema.mutable(Schema.Array(Schema.String)).pipe(
        settingsDefault([]),
      ),
    }),
  ]),
);

/**
 * Claude Agent SDK backend. The model is reached only through the explicit
 * proxy `provider`; there is no native login or API-key fallback.
 */
export const claudeBackendSchema = settingsStruct({
  type: Schema.Literal("claude"),
  /** Starting working directory, not a sandbox. */
  directory: absolutePath,
  model: Schema.String.check(
    settingsPattern(/^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/, {
      message: "Use a proxy model ID such as claude-sonnet-5-5",
    }),
  ),
  /** Anthropic Messages endpoint ending in `/v1`, as for OpenCode and Pi. */
  provider: piProviderSchema.check(
    settingsRefine((provider) => provider.baseURL.endsWith("/v1"), {
      message: "Claude provider baseURL must end with /v1",
    }),
  ),
  effort: Schema.optional(
    Schema.Literals(["low", "medium", "high", "xhigh", "max"]),
  ),
  /** Appended to Claude Code's own system prompt. */
  systemPrompt: Schema.optional(
    Schema.Trim.check(Schema.isMinCodePoints(1)).check(
      Schema.isMaxCodePoints(64_000),
    ),
  ),
  /** The only tools the model can see and run; every other one is absent. */
  allowedTools: claudeToolsSchema.pipe(settingsDefault([])),
  mcpServers: Schema.optional(claudeMcpServersSchema),
  /**
   * Filesystem settings to load from `directory`: `project` loads
   * `.claude/settings.json` and CLAUDE.md, `local` loads
   * `.claude/settings.local.json`. Empty by default.
   */
  settingSources: Schema.mutable(
    Schema.Array(Schema.Literals(["project", "local"])),
  )
    .check(Schema.isMaxLength(2))
    .check(
      settingsRefine((sources) => new Set(sources).size === sources.length, {
        message: "Duplicate settingSources entry",
      }),
    )
    .pipe(settingsDefault([])),
  maxTurns: Schema.Finite.check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(1))
    .check(Schema.isLessThanOrEqualTo(500))
    .pipe(settingsDefault(50)),
});
