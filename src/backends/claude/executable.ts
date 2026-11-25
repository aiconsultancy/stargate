import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { parseVersion } from "../../automation/maintenance/nightly/update/versions";

export const versionFailure =
  "Cannot verify Claude Code version for MCP delivery";

const sdkMetadata = Schema.Struct({ claudeCodeVersion: Schema.String });

/** Resolve from the SDK, never PATH, using its native platform preference. */
export function claudeCLI() {
  const entry = import.meta.resolve("@anthropic-ai/claude-agent-sdk");
  const require = createRequire(entry);
  const root = dirname(fileURLToPath(entry));

  const { claudeCodeVersion } = Schema.decodeUnknownSync(sdkMetadata)(
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
  );

  if (!parseVersion(claudeCodeVersion)) {
    throw new Error(versionFailure);
  }

  return {
    version: claudeCodeVersion,
    native: () => nativeClaudeExecutable(require.resolve),
  };
}

/** Resolve the SDK's platform binary, never a command from PATH. */
function nativeClaudeExecutable(resolve: (name: string) => string) {
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;

  const platform = `${process.platform}-${process.arch}`;

  const candidates =
    process.platform === "linux"
      ? report && report.header?.glibcVersionRuntime === undefined
        ? [`${platform}-musl`, platform]
        : [platform, `${platform}-musl`]
      : [platform];

  for (const target of candidates) {
    try {
      const path = resolve(
        `@anthropic-ai/claude-agent-sdk-${target}/claude${process.platform === "win32" ? ".exe" : ""}`,
      );

      if (existsSync(path)) {
        return path;
      }
    } catch {
      // This platform package is not installed; try the next candidate.
    }
  }

  throw new Error(versionFailure);
}
