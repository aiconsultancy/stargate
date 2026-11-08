import { pathToFileURL } from "node:url";
import type { ActivityWatch } from "./activity";
import { OpenCodeBackend } from "./backends/opencode";
import { PiDurableBackend } from "./backends/pi-durable";
import type { BackendConfig } from "./config";
import type { CrewStatus, CrewStatusInput } from "./crew-status";

/** Latest complete visible text for this turn, not reasoning or tool output. */
export type TextSink = (text: string) => void;

/** Adapters own their sessions; the gateway owns Slack and durable routing. */
export interface AgentBackend {
  createSession(input: {
    key: string;
    title: string;
    signal: AbortSignal;
  }): Promise<string>;
  prompt(
    sessionId: string,
    text: string,
    signal: AbortSignal,
    onText?: TextSink,
  ): Promise<string>;
  interrupt?(sessionId: string, signal: AbortSignal): Promise<void>;
  startActivity?(
    sessionId: string,
    requestID: string,
    reporter: string,
    signal: AbortSignal,
  ): Promise<ActivityWatch>;
  /** Sensitive, single-use pairing code. Never pass through model or storage. */
  pair?(signal: AbortSignal): Promise<{ code: string; expiresIn: number }>;
  /** Read-only configured crew status; does not require/create a conversation. */
  crewStatus?(input: CrewStatusInput, signal: AbortSignal): Promise<CrewStatus>;
  close(): Promise<void>;
}

export type BackendContext = { dataDirectory: string };

export async function createBackend(
  config: BackendConfig,
  context: BackendContext,
): Promise<AgentBackend> {
  switch (config.type) {
    case "opencode":
      return new OpenCodeBackend(config);
    case "pi-durable":
      return PiDurableBackend.open(config, context);
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
