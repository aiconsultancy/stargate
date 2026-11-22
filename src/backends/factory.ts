import { pathToFileURL } from "node:url";
import type { AgentBackend, BackendContext } from "./backend";
import type { BackendConfig } from "../config";
import { OpenCodeBackend } from "./opencode/opencode";
import { PiDurableBackend } from "./pi/pi-durable";

export async function createBackend(
  config: BackendConfig,
  context: BackendContext,
): Promise<AgentBackend> {
  switch (config.type) {
    case "opencode":
      return new OpenCodeBackend(config);
    case "pi-durable":
      return PiDurableBackend.open(config, context);
    case "claude": {
      // Loaded on demand: the SDK bundle is large and most bots do not use it.
      const { ClaudeBackend } = await import("./claude");
      return ClaudeBackend.open(config, context);
    }
    case "codex": {
      const { CodexBackend } = await import("./codex");
      return CodexBackend.open(config, context);
    }
    case "module": {
      const plugin: unknown = await import(pathToFileURL(config.module).href);
      if (
        typeof plugin !== "object" ||
        !plugin ||
        !("createBackend" in plugin) ||
        typeof plugin.createBackend !== "function"
      ) {
        throw new Error(
          "Backend module must export createBackend(options, context)",
        );
      }
      const backend: unknown = await plugin.createBackend(
        config.options,
        context,
      );
      if (
        typeof backend !== "object" ||
        !backend ||
        !["createSession", "prompt", "close"].every(
          (key) =>
            key in backend && typeof Reflect.get(backend, key) === "function",
        )
      ) {
        throw new Error("Backend module returned an invalid AgentBackend");
      }
      return backend as AgentBackend;
    }
  }
}
