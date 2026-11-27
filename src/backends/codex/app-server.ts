/**
 * Direct `codex app-server` JSON-RPC 2.0 client over stdio. Replaces
 * `codex exec` and `@openai/codex-sdk` runtime spawning while keeping
 * Stargate's `--config` override, sandbox, and process-cleanup invariants.
 */
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { Option, Predicate, Schema } from "effect";
import {
  type BackendFailureKind,
  statusKind,
} from "../../shared/request-failure";
import type { TurnStage } from "../../shared/turn-progress";
import type { ActivityItem, TurnActivityLog } from "../backend";
import type { codexBackendSchema } from "./config";

type Config = typeof codexBackendSchema.Type;

export type CodexConfigObject = {
  readonly [key: string]: CodexConfigValue;
};

export type CodexConfigValue =
  | string
  | number
  | boolean
  | readonly CodexConfigValue[]
  | CodexConfigObject;

export type CodexAppServerUserInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "localImage"; path: string };

export type CodexSandboxPolicy =
  | { type: "readOnly"; networkAccess: false }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: false;
      excludeSlashTmp: true;
    }
  | { type: "dangerFullAccess" };

export const MAX_LINE_BYTES = 16 * 1024 * 1024;

const APPROVAL_SERVER_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);

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

export const threadResponseSchema = Schema.Struct({
  thread: Schema.Struct({ id: Schema.String }),
});

export const turnResponseSchema = Schema.Struct({
  turn: Schema.Struct({ id: Schema.String.check(Schema.isMinLength(1)) }),
});

export const agentMessageDeltaSchema = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  itemId: Schema.String,
  delta: Schema.String,
});

export const itemNotificationSchema = Schema.Struct({
  threadId: Schema.optional(Schema.String),
  turnId: Schema.optional(Schema.String),
  item: Schema.Struct({
    id: Schema.String,
    type: Schema.String,
    text: Schema.optional(Schema.String),
    command: Schema.optional(Schema.String),
    tool: Schema.optional(Schema.String),
    name: Schema.optional(Schema.String),
    status: Schema.optional(Schema.String),
  }),
});

export const turnCompletedSchema = Schema.Struct({
  threadId: Schema.optional(Schema.String),
  turn: Schema.Struct({
    id: Schema.String,
    status: Schema.String,
    error: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          message: Schema.String,
        }),
      ),
    ),
  }),
});

export const errorNotificationSchema = Schema.Struct({
  error: Schema.Struct({
    message: Schema.String,
  }),
  willRetry: Schema.optional(Schema.Boolean),
  threadId: Schema.optional(Schema.String),
  turnId: Schema.optional(Schema.String),
});

export const decodeThreadResponse =
  Schema.decodeUnknownOption(threadResponseSchema);

export const decodeTurnResponse =
  Schema.decodeUnknownOption(turnResponseSchema);

export const decodeAgentMessageDelta = Schema.decodeUnknownOption(
  agentMessageDeltaSchema,
);

export const decodeItemNotification = Schema.decodeUnknownOption(
  itemNotificationSchema,
);

export const decodeTurnCompleted =
  Schema.decodeUnknownOption(turnCompletedSchema);

export const decodeErrorNotification = Schema.decodeUnknownOption(
  errorNotificationSchema,
);

function isConfigArray(
  value: CodexConfigValue,
): value is readonly CodexConfigValue[] {
  return Array.isArray(value);
}

const BARE_TOML_KEY = /^[A-Za-z0-9_-]+$/;

function formatTomlKey(segment: string): string {
  return BARE_TOML_KEY.test(segment) ? segment : JSON.stringify(segment);
}

function serializeTomlValue(value: CodexConfigValue): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (isConfigArray(value)) {
    return `[${value.map((entry) => serializeTomlValue(entry)).join(",")}]`;
  }

  const pairs = Object.entries(value).map(
    ([key, entry]) => `${formatTomlKey(key)}=${serializeTomlValue(entry)}`,
  );

  return `{${pairs.join(",")}}`;
}

function hasOnlyBareKeys(value: CodexConfigObject): boolean {
  return Object.keys(value).every((key) => BARE_TOML_KEY.test(key));
}

function flattenTomlOverrides(
  value: CodexConfigObject,
  prefix: string,
  out: string[],
): void {
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix.length > 0 ? `${prefix}.${key}` : key;

    if (
      Predicate.isObject(entry) &&
      !isConfigArray(entry) &&
      Object.keys(entry).length > 0 &&
      hasOnlyBareKeys(entry)
    ) {
      flattenTomlOverrides(entry, path, out);
    } else {
      out.push("-c", `${path}=${serializeTomlValue(entry)}`);
    }
  }
}

/** Build `codex app-server` CLI arguments with `--config` overrides. */
export function codexAppServerArgs(overrides: CodexConfigObject): string[] {
  const args = ["app-server"];
  flattenTomlOverrides(overrides, "", args);

  return args;
}

/** Explicit `turn/start` sandbox policy matching Stargate's Codex contract. */
export function codexSandboxPolicy(config: Config): CodexSandboxPolicy {
  if (config.sandbox === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }

  if (config.sandbox === "workspace-write") {
    return {
      type: "workspaceWrite",
      writableRoots: [config.directory],
      networkAccess: config.network,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: true,
    };
  }

  return { type: "readOnly", networkAccess: false };
}

export class CodexAppServerRpcError extends Error {
  public constructor(
    public readonly method: string,
    public readonly code: number,
    public readonly errorMessage: string,
  ) {
    super(`Codex app-server ${method} failed (${code})`);
  }
}

type PendingCall = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

/**
 * Bidirectional JSON-RPC 2.0 NDJSON transport for `codex app-server`.
 * Declines approval requests and rejects unknown server requests fail-closed.
 */
export class CodexAppServerClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly exited: Promise<number | null>;
  private closed = false;
  private closeError: Error | undefined;
  private buffer = "";

  public constructor(
    private readonly child: ChildProcessByStdio<Writable, Readable, null>,
    private readonly onNotification: (method: string, params: unknown) => void,
    private readonly onFailure?: (error: Error) => void,
  ) {
    this.exited = new Promise((resolve) => {
      child.once("exit", (code) => {
        this.failAll(new Error("Codex app-server exited"));
        resolve(code);
      });
      child.once("error", () => {
        this.failAll(new Error("Codex app-server failed to start"));
        resolve(null);
      });
    });

    child.stdin.on("error", () => {
      this.failAll(new Error("Codex app-server stdin error"));
    });
    child.stdout.on("error", () => {
      this.failAll(new Error("Codex app-server stdout error"));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.consumeStdout(chunk);
    });
  }

  public get running(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  public get done(): Promise<number | null> {
    return this.exited;
  }

  public request(
    method: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(
        this.closeError ?? new Error("Codex app-server is closed"),
      );
    }

    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs !== undefined && timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`Codex app-server ${method} timed out`));
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
    if (!this.running) {
      return;
    }

    try {
      this.child.kill(signal);
    } catch {
      // Already exited.
    }
  }

  public closePipes(): void {
    try {
      this.child.stdin.destroy();
    } catch {
      // Already closed.
    }

    try {
      this.child.stdout.destroy();
    } catch {
      // Already closed.
    }
  }

  public endInput(): void {
    try {
      this.child.stdin.end();
    } catch {
      // Already closed.
    }
  }

  public abort(error: Error): void {
    this.failAll(error);
  }

  private writeMessage(payload: Record<string, unknown>): void {
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch {
      this.failAll(new Error("Codex app-server stdin write failed"));
    }
  }

  private consumeStdout(chunk: string): void {
    this.buffer += chunk;

    let nl = this.buffer.indexOf("\n");

    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);

      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
        this.buffer = "";
        this.failAll(new Error("Codex app-server line overflow"));

        return;
      }

      if (line.length > 0) {
        this.handleLine(line);
      }

      nl = this.buffer.indexOf("\n");
    }

    const pending = this.buffer.endsWith("\r")
      ? this.buffer.slice(0, -1)
      : this.buffer;

    if (Buffer.byteLength(pending, "utf8") > MAX_LINE_BYTES) {
      this.buffer = "";
      this.failAll(new Error("Codex app-server line overflow"));
    }
  }

  private handleLine(line: string): void {
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
      if (APPROVAL_SERVER_METHODS.has(msg.method)) {
        this.writeMessage({
          jsonrpc: "2.0",
          id: msg.id,
          result: { decision: "decline" },
        });
      } else {
        this.writeMessage({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32_601, message: "Unsupported client method" },
        });
      }

      return;
    }

    if (msg.method !== undefined) {
      this.onNotification(msg.method, msg.params);

      return;
    }

    if (typeof msg.id === "number") {
      const entry = this.pending.get(msg.id);

      if (!entry) {
        return;
      }

      this.pending.delete(msg.id);

      if (entry.timer !== undefined) {
        clearTimeout(entry.timer);
      }

      if (msg.error !== undefined) {
        entry.reject(
          new CodexAppServerRpcError(
            entry.method,
            msg.error.code,
            msg.error.message,
          ),
        );

        return;
      }

      entry.resolve(msg.result);
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
    this.onFailure?.(error);
  }
}

/** V2 app-server item kinds that mean the turn did work outside the model. */
const workItems = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
]);

/**
 * The category and HTTP status that a Codex error message names. Only
 * these two values are kept: the message can quote the provider.
 */
export function codexFailureKind(
  message: string,
): { kind: BackendFailureKind; status?: number } | undefined {
  const status =
    /\bstatus(?: code)?:? ([1-5]\d\d)\b/i.exec(message)?.[1] ??
    /\b([45]\d\d) (?:Bad Request|Unauthorized|Payment Required|Forbidden|Not Found|Request Timeout|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i.exec(
      message,
    )?.[1];

  if (status) {
    return { kind: statusKind(Number(status)), status: Number(status) };
  }

  if (/usage limit|rate limit|quota|too many requests/i.test(message)) {
    return { kind: "quota" };
  }

  if (/unauthorized|api key|authentication|access token/i.test(message)) {
    return { kind: "auth" };
  }

  if (/timed out|timeout/i.test(message)) {
    return { kind: "timeout" };
  }

  if (
    /error sending request|connection (?:refused|reset|closed)|stream disconnected|dns error|network/i.test(
      message,
    )
  ) {
    return { kind: "network" };
  }

  return undefined;
}

export function notificationIds(params: unknown): {
  threadId?: string;
  turnId?: string;
} {
  if (!Predicate.isObject(params) || Array.isArray(params)) {
    return {};
  }

  const threadId =
    typeof params["threadId"] === "string" ? params["threadId"] : undefined;

  let turnId =
    typeof params["turnId"] === "string" ? params["turnId"] : undefined;

  if (turnId === undefined) {
    const turn = params["turn"];

    if (
      Predicate.isObject(turn) &&
      !Array.isArray(turn) &&
      typeof turn["id"] === "string"
    ) {
      turnId = turn["id"];
    }
  }

  const ids: { threadId?: string; turnId?: string } = {};

  if (threadId !== undefined) {
    ids.threadId = threadId;
  }

  if (turnId !== undefined) {
    ids.turnId = turnId;
  }

  return ids;
}

/**
 * Visible text of one `codex app-server` turn: agent messages only, never
 * reasoning, commands, tool output or error items. Failure text is never kept.
 */
export class CodexTurn {
  private readonly messages = new Map<string, string>();
  public result: { ok: boolean } | undefined;
  /** A command, file change or tool call was seen. */
  public worked = false;
  /** What the failure event named, without its text. */
  public failure: ReturnType<typeof codexFailureKind>;

  public constructor(private readonly activity?: TurnActivityLog) {}

  /** Apply one app-server notification. Returns true when visible text changed. */
  public addNotification(
    method: string,
    params: unknown,
    stage?: (stage: TurnStage) => void,
  ): boolean {
    const now = Date.now();

    if (method === "turn/started") {
      stage?.("model");

      return false;
    }

    if (
      method === "item/reasoning/textDelta" ||
      method === "item/reasoning/summaryTextDelta"
    ) {
      stage?.("reasoning");

      return false;
    }

    if (method === "item/agentMessage/delta") {
      const delta = Option.getOrUndefined(decodeAgentMessageDelta(params));

      if (!delta || delta.delta.length === 0) {
        return false;
      }

      const next = (this.messages.get(delta.itemId) ?? "") + delta.delta;
      this.messages.set(delta.itemId, next);
      stage?.("reply");
      this.recordText("text", this.answer(), now);

      return true;
    }

    if (method === "item/started" || method === "item/completed") {
      return this.applyItem(method, params, now, stage);
    }

    if (method === "error") {
      const err = Option.getOrUndefined(decodeErrorNotification(params));

      if (err) {
        this.failure = codexFailureKind(err.error.message) ?? this.failure;

        if (err.willRetry === false) {
          this.result = { ok: false };
        }
      }

      return false;
    }

    if (method === "turn/completed") {
      const done = Option.getOrUndefined(decodeTurnCompleted(params));

      if (done) {
        this.result = { ok: done.turn.status === "completed" };

        if (!this.result.ok && done.turn.error?.message) {
          this.failure =
            codexFailureKind(done.turn.error.message) ?? this.failure;
        }
      }
    }

    return false;
  }

  public answer(): string {
    return [...this.messages.values()].filter(Boolean).join("\n\n");
  }

  private applyItem(
    method: "item/started" | "item/completed",
    params: unknown,
    now: number,
    stage?: (stage: TurnStage) => void,
  ): boolean {
    const decoded = Option.getOrUndefined(decodeItemNotification(params));

    if (!decoded) {
      return false;
    }

    const { id, type, text, command, tool, name, status } = decoded.item;
    const isWork = workItems.has(type);

    if (method === "item/started") {
      if (type === "reasoning") {
        stage?.("reasoning");
      } else if (isWork) {
        stage?.("tool");
      } else if (type === "agentMessage") {
        stage?.("reply");
      }
    }

    if (isWork) {
      this.worked = true;
      let toolStatus: "running" | "completed" | "failed" = "running";

      if (method === "item/completed") {
        toolStatus = status === "failed" ? "failed" : "completed";
      }

      this.recordTool(
        id,
        tool ?? name ?? type,
        toolStatus,
        command ? { command } : null,
        now,
      );
    }

    if (type === "reasoning" && text) {
      this.recordText("reasoning", text, now);

      return false;
    }

    if (type !== "agentMessage" || text === undefined) {
      return false;
    }

    if (this.messages.get(id) === text) {
      return false;
    }

    this.messages.set(id, text);
    this.recordText("text", this.answer(), now);

    return true;
  }

  private recordText(
    kind: "text" | "reasoning",
    text: string,
    at: number,
  ): void {
    try {
      this.activity?.update(
        kind,
        at,
        (): ActivityItem => ({ kind, status: "streaming", text }),
        (item) => {
          if (item.kind === kind) {
            item.text = text;
          }
        },
      );
    } catch {
      // Observability is best effort.
    }
  }

  private recordTool(
    callId: string,
    name: string,
    status: "running" | "completed" | "failed",
    input: Readonly<Record<string, unknown>> | null,
    at: number,
  ): void {
    try {
      this.activity?.update(
        `tool:${callId}`,
        at,
        (): ActivityItem => ({
          kind: "tool",
          callId,
          name,
          status,
          rawInput: input ? JSON.stringify(input) : "",
          input,
          executed: true,
          metadata: null,
          content: null,
          error: null,
        }),
        (item) => {
          if (item.kind === "tool") {
            item.status = status;
          }
        },
      );
    } catch {
      // Observability is best effort.
    }
  }
}
