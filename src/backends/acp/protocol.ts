/**
 * ACP (Agent Client Protocol) JSON-RPC 2.0 wire schemas and stdio framing.
 * Adapted in part from T3 Code `packages/effect-acp` (MIT License, Copyright
 * 2026 T3 Tools Inc.).
 */
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { Option, Predicate, Schema } from "effect";

export const ACP_PROTOCOL_VERSION = 1;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;

export type AcpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string };

export const acpPermissionOptionSchema = Schema.Struct({
  optionId: Schema.String,
  name: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
});

export type AcpPermissionOption = typeof acpPermissionOptionSchema.Type;

export const acpToolCallSchema = Schema.Struct({
  toolCallId: Schema.String,
  title: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  rawInput: Schema.optional(Schema.Unknown),
  rawOutput: Schema.optional(Schema.Unknown),
  content: Schema.optional(Schema.Unknown),
  locations: Schema.optional(Schema.Unknown),
  _meta: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

export type AcpToolCall = typeof acpToolCallSchema.Type;

export const acpPermissionRequestSchema = Schema.Struct({
  sessionId: Schema.String,
  toolCall: acpToolCallSchema,
  options: Schema.Array(acpPermissionOptionSchema),
});

export type AcpPermissionRequest = typeof acpPermissionRequestSchema.Type;

export const acpConfigSelectChoiceSchema = Schema.Struct({
  value: Schema.String,
  name: Schema.optional(Schema.String),
});

export const acpConfigSelectGroupSchema = Schema.Struct({
  group: Schema.optional(Schema.String),
  options: Schema.Array(acpConfigSelectChoiceSchema),
});

export const acpConfigOptionSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  category: Schema.optional(Schema.String),
  currentValue: Schema.optional(Schema.String),
  options: Schema.optional(
    Schema.Array(
      Schema.Union([acpConfigSelectChoiceSchema, acpConfigSelectGroupSchema]),
    ),
  ),
});

export type AcpConfigOption = typeof acpConfigOptionSchema.Type;

export const acpModeStateSchema = Schema.Struct({
  currentModeId: Schema.optional(Schema.String),
  availableModes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optional(Schema.String),
    }),
  ),
});

export type AcpModeState = typeof acpModeStateSchema.Type;

export const acpInitializeResultSchema = Schema.Struct({
  protocolVersion: Schema.optional(Schema.Number),
  agentInfo: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      version: Schema.optional(Schema.String),
    }),
  ),
  agentCapabilities: Schema.optional(
    Schema.Struct({
      loadSession: Schema.optional(Schema.Boolean),
      sessionCapabilities: Schema.optional(
        Schema.Record(Schema.String, Schema.Unknown),
      ),
      _meta: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
});

export type AcpInitializeResult = typeof acpInitializeResultSchema.Type;

export const acpSessionResultSchema = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  modes: Schema.optional(acpModeStateSchema),
  configOptions: Schema.optional(Schema.Array(acpConfigOptionSchema)),
});

export type AcpSessionResult = typeof acpSessionResultSchema.Type;

export const acpPromptResultSchema = Schema.Struct({
  stopReason: Schema.optional(Schema.String),
});

export type AcpPromptResult = typeof acpPromptResultSchema.Type;

const jsonRpcIdSchema = Schema.Union([Schema.Number, Schema.String]);

const jsonRpcErrorSchema = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optional(Schema.Unknown),
});

const jsonRpcEnvelopeSchema = Schema.Struct({
  jsonrpc: Schema.optional(Schema.Literal("2.0")),
  id: Schema.optional(jsonRpcIdSchema),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(jsonRpcErrorSchema),
});

export const decodeInitializeResult = Schema.decodeUnknownOption(
  acpInitializeResultSchema,
);

export const decodeSessionResult = Schema.decodeUnknownOption(
  acpSessionResultSchema,
);

export const decodePromptResult = Schema.decodeUnknownOption(
  acpPromptResultSchema,
);

export const decodePermissionRequest = Schema.decodeUnknownOption(
  acpPermissionRequestSchema,
);

export class AcpRpcError extends Error {
  public constructor(
    public readonly method: string,
    public readonly code: number,
    public readonly errorMessage: string,
    public readonly data?: unknown,
  ) {
    super(`ACP ${method} failed (${code})`);
  }
}

export class AcpTransportError extends Error {
  public constructor(
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
  }
}

export type AcpRequestHandler = (
  method: string,
  params: unknown,
) => Promise<unknown>;

export type AcpNotificationHandler = (method: string, params: unknown) => void;

export type AcpLineInterceptor = (line: string) => "consume" | "pass";

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

export type AcpStdioConnectionOptions = {
  onNotification: AcpNotificationHandler;
  onRequest: AcpRequestHandler;
  interceptStdoutLine?: AcpLineInterceptor;
  onStderrLine?: (line: string) => void;
  isCancelled?: () => boolean;
};

/**
 * Bidirectional JSON-RPC 2.0 NDJSON transport over a child process's stdio.
 * Keeps stderr bounded and never leaks raw stdout/stderr into error messages.
 */
export class AcpStdioConnection {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly exited: Promise<number | null>;
  private closed = false;
  private closeError: Error | undefined;
  private stdoutBuffer = "";
  private stderrTail = "";

  public constructor(
    private readonly child: ChildProcessByStdio<Writable, Readable, Readable>,
    private readonly options: AcpStdioConnectionOptions,
  ) {
    this.exited = new Promise((resolve) => {
      child.once("exit", (code) => {
        this.failAll(
          new AcpTransportError("ACP process exited before answering"),
        );
        resolve(code);
      });
      child.once("error", () => {
        this.failAll(new AcpTransportError("ACP process failed to start"));
        resolve(null);
      });
    });

    child.stdin.on("error", () => {
      this.failAll(new AcpTransportError("ACP stdin pipe error"));
    });
    child.stdout.on("error", () => {
      this.failAll(new AcpTransportError("ACP stdout pipe error"));
    });
    child.stderr.on("error", () => {
      // Ignore stderr pipe errors during teardown.
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.consumeStdout(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.consumeStderr(chunk);
    });
  }

  public get pid(): number | undefined {
    return this.child.pid;
  }

  public get running(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  public get done(): Promise<number | null> {
    return this.exited;
  }

  public get stderrExcerpt(): string {
    return this.stderrTail;
  }

  public abortTransport(error: Error): void {
    this.failAll(error);
  }

  public request(
    method: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(
        this.closeError ?? new AcpTransportError("ACP connection is closed"),
      );
    }

    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs !== undefined && timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new AcpTransportError(`ACP ${method} timed out`));
            }, timeoutMs)
          : undefined;

      this.pending.set(id, { method, resolve, reject, timer });
      this.writeMessage({ jsonrpc: "2.0", id, method, params });
    });
  }

  public notify(method: string, params: unknown): void {
    if (this.closed) {
      return;
    }

    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  public kill(signal: NodeJS.Signals): void {
    const pid = this.child.pid;

    if (!this.running || pid === undefined) {
      return;
    }

    try {
      process.kill(-pid, signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        // Already exited.
      }
    }
  }

  public endInput(): void {
    try {
      this.child.stdin.end();
    } catch {
      // Pipe already closed.
    }
  }

  private writeMessage(payload: Record<string, unknown>): void {
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch {
      this.failAll(new AcpTransportError("ACP stdin write failed"));
    }
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;

    if (this.stdoutBuffer.length > MAX_LINE_BYTES) {
      this.stdoutBuffer = "";
      this.failAll(new AcpTransportError("ACP stdout line exceeded limit"));

      return;
    }

    let newline = this.stdoutBuffer.indexOf("\n");

    while (newline !== -1) {
      const rawLine = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);

      if (rawLine.length > 0) {
        this.handleStdoutLine(rawLine);
      }

      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleStdoutLine(line: string): void {
    if (this.options.interceptStdoutLine?.(line) === "consume") {
      return;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    const decoded = Schema.decodeUnknownOption(jsonRpcEnvelopeSchema)(parsed);

    if (Option.isNone(decoded)) {
      return;
    }

    const msg = decoded.value;

    if (msg.method !== undefined && msg.id !== undefined) {
      void this.handleServerRequest(msg.id, msg.method, msg.params);

      return;
    }

    if (msg.method !== undefined) {
      this.options.onNotification(msg.method, msg.params);

      return;
    }

    if (typeof msg.id === "number") {
      this.handleResponse(msg.id, msg.result, msg.error);
    }
  }

  private handleResponse(
    id: number,
    result: unknown,
    error: typeof jsonRpcErrorSchema.Type | undefined,
  ): void {
    const entry = this.pending.get(id);

    if (!entry) {
      return;
    }

    this.pending.delete(id);

    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
    }

    if (error !== undefined) {
      entry.reject(
        new AcpRpcError(entry.method, error.code, error.message, error.data),
      );

      return;
    }

    entry.resolve(result);
  }

  private async handleServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    try {
      const result = await this.options.onRequest(method, params);

      if (!this.closed) {
        const reply =
          method === "session/request_permission" &&
          this.options.isCancelled?.()
            ? { outcome: { outcome: "cancelled" } }
            : result;

        this.writeMessage({ jsonrpc: "2.0", id, result: reply });
      }
    } catch {
      if (!this.closed) {
        this.writeMessage({
          jsonrpc: "2.0",
          id,
          error: { code: -32_603, message: "Client request handler failed" },
        });
      }
    }
  }

  private consumeStderr(chunk: string): void {
    this.stderrTail = (this.stderrTail + chunk).slice(-MAX_STDERR_BYTES);

    if (!this.options.onStderrLine) {
      return;
    }

    for (const line of chunk.split(/\r?\n/)) {
      if (line.length > 0) {
        this.options.onStderrLine(line);
      }
    }
  }

  private failAll(error: Error): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.closeError = error;

    for (const entry of this.pending.values()) {
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer);
      }

      entry.reject(error);
    }

    this.pending.clear();
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return Predicate.isObject(value) && !Array.isArray(value) ? value : undefined;
}
