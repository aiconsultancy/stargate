import { pathToFileURL } from "node:url";
import type { ActivityWatch } from "./activity";
import type { Attachment } from "./attachments";
import { OpenCodeBackend } from "./backends/opencode";
import { PiDurableBackend } from "./backends/pi-durable";
import type { BackendConfig } from "./config";
import type { PiCrewBinding } from "./crew/pi-extension";
import type { CrewStatus, CrewStatusInput } from "./crew-status";
import type { MaintenanceWatch } from "./maintenance";
import type { QuotaSnapshot } from "./quota";
import type { SessionHistory } from "./session-history";

/** Model-visible source identity only; never repeat chat history here. */
export type PromptSourceContext = {
  source: {
    /** Absent means Slack. */
    transport?: "irc";
    channel: string;
    thread: string;
    message: string;
    user: string;
    /** `captain`: a verified peer captain; `crew`: this ship's IRC account. */
    sender?: "captain" | "crew";
  };
};

/** Compact source line: `s=slack;c=…;t=…;m=…;u=…[;k=…]`. */
export function sourceLine({ source }: PromptSourceContext) {
  const value = encodeURIComponent;
  return `s=${source.transport ?? "slack"};c=${value(source.channel)};t=${value(source.thread)};m=${value(source.message)};u=${value(source.user)}${source.sender ? `;k=${source.sender}` : ""}`;
}

/** Latest complete visible text for this turn, not reasoning or tool output. */
export type TextSink = (text: string) => void;

/** Public text of one settled assistant message; never reasoning or tools. */
export type TranscriptEntry = {
  id: string;
  text: string;
  created: number;
  /** Proven origin; unknown or mixed adjacent crew batches clear ownership. */
  input?: string;
};

/**
 * Settled entries after a native message cursor, oldest first. `cursor` is the
 * newest settled message ID ("" before the first message). `pending` means
 * unsettled messages follow `cursor`. A cursor missing from readable history
 * is an error, never a silent skip.
 */
export type Transcript = {
  cursor: string;
  entries: TranscriptEntry[];
  /** Last proven/unmapped boundary; absent inherits owner. Crew cursors re-anchor. */
  input?: string;
  pending?: true;
};

/**
 * Permanent transcript failures: the mapped session or the stored cursor no
 * longer exists. Transient read errors stay ordinary errors.
 */
export class TranscriptUnavailable extends Error {
  constructor(readonly reason: "session" | "cursor") {
    super(
      reason === "session"
        ? "Mapped session no longer exists"
        : "Transcript cursor is not in session history",
    );
  }
}

/** `after` value for messages after this adapter's latest prompt input. */
export const latestInput = "\u0000latest-input";

/** Adapters own their sessions; the gateway owns Slack and durable routing. */
export interface AgentBackend {
  /** Explicit capability: unsupported adapters must not silently drop files. */
  readonly supportsAttachments?: boolean;
  /** Explicit durable identity; the gateway scopes routing to this session. */
  readonly sessionID?: string | undefined;
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
    /** Persist the allocated native input ID synchronously before admission. */
    onInput?: (id: string) => void,
    files?: readonly Attachment[],
    context?: PromptSourceContext,
  ): Promise<string>;
  interrupt?(sessionId: string, signal: AbortSignal): Promise<void>;
  /** Withdraw this input; interrupt only if raw history proves it is current. */
  interruptInput?(
    sessionId: string,
    inputId: string,
    signal: AbortSignal,
  ): Promise<void>;
  startMaintenance?(
    sessionId: string,
    requestID: string,
    signal: AbortSignal,
  ): Promise<MaintenanceWatch>;
  /**
   * Public assistant text after `after`. Undefined `after` returns only the
   * current baseline; "" reads from the start of the session.
   */
  transcript?(
    sessionId: string,
    after: string | undefined,
    signal: AbortSignal,
  ): Promise<Transcript>;
  /**
   * Report sessions that settle outside prompt calls; no session ID means
   * (re)connected. Resolves after the signal aborts.
   */
  watch?(
    onSettled: (sessionId?: string) => void,
    signal: AbortSignal,
  ): Promise<void>;
  startActivity?(
    sessionId: string,
    requestID: string,
    reporter: string | undefined,
    signal: AbortSignal,
  ): Promise<ActivityWatch>;
  resumeActivity?(sessionId: string, capture: string): ActivityWatch;
  /** Sensitive, single-use pairing code. Never pass through model or storage. */
  pair?(signal: AbortSignal): Promise<{ code: string; expiresIn: number }>;
  /** Read-only configured crew status; does not require/create a conversation. */
  crewStatus?(input: CrewStatusInput, signal: AbortSignal): Promise<CrewStatus>;
  /** Sanitized subscription limits; never runs a model or creates a session. */
  quota?(signal: AbortSignal): Promise<QuotaSnapshot>;
  /** Read-only transcripts for operator views; never prompts or mutates. */
  readonly history?: SessionHistory;
  close(): Promise<void>;
}

export type BackendContext = {
  dataDirectory: string;
  crew?: PiCrewBinding;
  workingAgreement?: { path: string; owns(conversationID: string): boolean };
};

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
      const { ClaudeBackend } = await import("./backends/claude");
      return ClaudeBackend.open(config, context);
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
