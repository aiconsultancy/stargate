/**
 * ACP session lifecycle runner for Bun/Stargate. Distilled from T3 Code
 * `packages/provider-acp/src/server/AcpSessionRuntime.ts` and
 * `packages/provider-acp-registry/src/server/copilotAcp.ts`
 * (MIT License, Copyright 2026 T3 Tools Inc.).
 */
import { spawn as spawnChild } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Option } from "effect";
import packageJson from "../../../package.json" with { type: "json" };
import type {
  ActivityItem,
  ActivityOutcome,
  ActivityRequest,
  TextSink,
  TurnActivityLog,
  TurnActivityRecorder,
} from "../backend";
import {
  BackendFailure,
  type BackendFailureKind,
  statusKind,
} from "../../shared/request-failure";
import type { TurnProgress, TurnStage } from "../../shared/turn-progress";
import { statStart, stopTurnProcesses, systemProcesses } from "../cli-agent";
import type { AcpFlavor, AcpPermissionPolicy } from "../config";
import { evaluateAcpPermission } from "./policy";
import {
  ACP_PROTOCOL_VERSION,
  type AcpConfigOption,
  type AcpContentBlock,
  type AcpInitializeResult,
  type AcpLineInterceptor,
  type AcpModeState,
  AcpRpcError,
  AcpStdioConnection,
  type AcpStdioConnectionOptions,
  AcpTransportError,
  asRecord,
  decodeInitializeResult,
  decodePermissionRequest,
  decodePromptResult,
  decodeSessionResult,
} from "./protocol";

export const acpTurnVariable = "STARGATE_ACP_TURN";

const COPILOT_META_KEY = "github.com/copilot";
const COPILOT_SESSION_EVENT = "github.com/copilot/sessionEvent";

const COPILOT_LOST_SESSION_MARKERS = [
  "session event delivery failed: session not found: ",
  "session lock unavailable during is_session_generation_current: acquisition timed out",
] as const;

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 5000;
const DEFAULT_REPLAY_IDLE_MS = 1500;

export type AcpRunSpec = {
  readonly sessionId: string;
  readonly nativeSessionId: string | undefined;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly prompt: readonly AcpContentBlock[];
  readonly flavor: AcpFlavor;
  readonly backendTag: "acp" | "antigravity";
  readonly permissionPolicy: AcpPermissionPolicy;
  readonly extraRoots: readonly string[];
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly mode?: string | undefined;
  readonly authMethodId?: string | undefined;
  readonly authenticateEagerly?: boolean | undefined;
  readonly resumeMethod: "load" | "resume" | "none";
  readonly cancelBehavior: "wait-for-prompt" | "interrupt";
  readonly recordPath: string;
  readonly turnMarker: string;
  readonly graceMs: number;
  readonly startupTimeoutMs?: number | undefined;
  readonly replayIdleMs?: number | undefined;
  readonly sessionMeta?:
    | ((init: AcpInitializeResult) => Record<string, unknown> | undefined)
    | undefined;
  readonly resolveMode?:
    | ((mode: string, state: AcpModeState | undefined) => string)
    | undefined;
  readonly resolveModel?:
    | ((
        options: readonly AcpConfigOption[],
        requested: string | undefined,
      ) => string | undefined)
    | undefined;
  readonly interceptStdoutLine?:
    | ((line: string, abort: (error: Error) => void) => "consume" | "pass")
    | undefined;
  readonly classifyError?:
    | ((error: unknown, ran: boolean) => BackendFailure | undefined)
    | undefined;
  readonly onText?: TextSink | undefined;
  readonly onProgress?: ((progress: TurnProgress) => void) | undefined;
  readonly activity?: TurnActivityRecorder | undefined;
  readonly activityRequests?: (() => readonly ActivityRequest[]) | undefined;
  readonly signal: AbortSignal;
};

export type AcpRunOutcome = {
  readonly nativeSessionId: string;
  readonly answer: string;
  readonly stopReason: string | undefined;
};

export function isCopilotLostSessionError(error: unknown): boolean {
  if (
    !(error instanceof AcpRpcError) ||
    error.method !== "session/prompt" ||
    error.code !== -32_603
  ) {
    return false;
  }

  const details = asRecord(error.data)?.["details"];

  return [error.errorMessage, details].some(
    (value) =>
      typeof value === "string" &&
      COPILOT_LOST_SESSION_MARKERS.some((marker) => value.includes(marker)),
  );
}

export function classifyAcpFailure(
  error: unknown,
  ran: boolean,
): BackendFailure | undefined {
  if (error instanceof BackendFailure) {
    return error;
  }

  if (error instanceof AcpRpcError) {
    const details = asRecord(error.data)?.["details"];

    const text = [
      error.errorMessage,
      typeof details === "string" ? details : "",
    ]
      .filter((part) => part.length > 0)
      .join(" ");

    const status = /\b([45]\d\d)\b/.exec(text)?.[1];

    if (status !== undefined) {
      return new BackendFailure(statusKind(Number(status)), {
        status: Number(status),
        ran,
      });
    }

    if (
      error.code === -32_000 ||
      /auth|unauthorized|sign in|login|api key|credential/i.test(text)
    ) {
      return new BackendFailure("auth", { ran });
    }

    if (/quota|rate limit|too many requests|billing/i.test(text)) {
      return new BackendFailure("quota", { ran });
    }

    if (/model.*not found|unknown model|invalid model/i.test(text)) {
      return new BackendFailure("model", { ran });
    }

    if (/timeout|timed out/i.test(text)) {
      return new BackendFailure("timeout", { ran });
    }

    if (/network|econnrefused|econnreset|enotfound|fetch failed/i.test(text)) {
      return new BackendFailure("network", { ran });
    }

    return new BackendFailure("provider", { ran });
  }

  if (error instanceof AcpTransportError) {
    const kind: BackendFailureKind = /timed out/i.test(error.message)
      ? "timeout"
      : "crash";

    return new BackendFailure(kind, { ran: true });
  }

  return undefined;
}

function configSelectValues(option: AcpConfigOption): string[] {
  const values: string[] = [];

  for (const entry of option.options ?? []) {
    if ("value" in entry) {
      values.push(entry.value);
    } else {
      for (const nested of entry.options) {
        values.push(nested.value);
      }
    }
  }

  return values;
}

function clientCapabilitiesFor(flavor: AcpFlavor): Record<string, unknown> {
  const base: Record<string, unknown> = {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  };

  if (flavor === "copilot") {
    base["_meta"] = {
      [COPILOT_META_KEY]: {
        events: [
          "subagent.started",
          "subagent.completed",
          "subagent.failed",
          "assistant.message_delta",
          "assistant.reasoning_delta",
          "session.compaction_complete",
          "assistant.turn_start",
          "assistant.idle",
          "tool.execution_start",
        ],
      },
    };
  }

  return base;
}

type CopilotState = {
  deltaTask: string | undefined;
  readonly taskByAgentId: Map<string, string>;
};

class AcpTurnCollector {
  private readonly chunks: string[] = [];
  private readonly thoughts: string[] = [];
  private readonly copilot: CopilotState = {
    deltaTask: undefined,
    taskByAgentId: new Map(),
  };
  private readonly activity: TurnActivityLog | undefined;
  public replaying = false;
  public replayCount = 0;
  public lastReplayAt = 0;
  public worked = false;

  public constructor(
    private readonly spec: AcpRunSpec,
    activity: TurnActivityLog | undefined,
  ) {
    this.activity = activity;
  }

  public visible(): string {
    return this.chunks.join("");
  }

  public handleNotification(method: string, params: unknown): void {
    if (method === COPILOT_SESSION_EVENT && this.spec.flavor === "copilot") {
      this.handleCopilotEvent(params);

      return;
    }

    if (method !== "session/update") {
      return;
    }

    const record = asRecord(params);
    const update = asRecord(record?.["update"]);

    if (!update) {
      return;
    }

    if (this.replaying) {
      this.replayCount += 1;
      this.lastReplayAt = Date.now();

      return;
    }

    this.applyUpdate(update);
  }

  public endActivity(outcome: ActivityOutcome): void {
    try {
      this.activity?.end(outcome);
    } catch {
      // Observability never disrupts turn completion.
    }
  }

  private emitStage(stage: TurnStage): void {
    this.spec.onProgress?.({
      stage,
      observedAt: Date.now(),
      backend: this.spec.backendTag,
    });
  }

  private handleCopilotEvent(params: unknown): void {
    const event = asRecord(params);

    if (!event) {
      return;
    }

    const type = event["type"];

    const agentId =
      typeof event["agentId"] === "string" ? event["agentId"] : undefined;

    const data = asRecord(event["data"]);

    if (type === "subagent.started" && agentId && data) {
      const callId = data["toolCallId"];

      if (typeof callId === "string") {
        this.copilot.taskByAgentId.set(agentId, callId);
      }

      return;
    }

    if (
      (type === "subagent.completed" || type === "subagent.failed") &&
      agentId
    ) {
      this.copilot.taskByAgentId.delete(agentId);

      return;
    }

    if (
      (type === "assistant.message_delta" ||
        type === "assistant.reasoning_delta") &&
      data
    ) {
      const parent =
        typeof data["parentToolCallId"] === "string"
          ? data["parentToolCallId"]
          : agentId
            ? this.copilot.taskByAgentId.get(agentId)
            : undefined;

      this.copilot.deltaTask = parent;
    }
  }

  private applyUpdate(update: Record<string, unknown>): void {
    const kind = update["sessionUpdate"];
    const now = Date.now();

    if (kind === "agent_message_chunk") {
      const subagent = this.copilot.deltaTask !== undefined;
      this.copilot.deltaTask = undefined;

      if (subagent) {
        return;
      }

      const content = asRecord(update["content"]);

      if (content?.["type"] === "text" && typeof content["text"] === "string") {
        this.chunks.push(content["text"]);
        this.emitStage("reply");
        const visible = this.visible();

        if (visible.length > 0) {
          this.spec.onText?.(visible);
        }

        this.recordText("text", visible, now);
      }

      return;
    }

    if (kind === "agent_thought_chunk") {
      this.copilot.deltaTask = undefined;
      const content = asRecord(update["content"]);

      if (content?.["type"] === "text" && typeof content["text"] === "string") {
        this.thoughts.push(content["text"]);
        this.emitStage("reasoning");
        this.recordText("reasoning", this.thoughts.join(""), now);
      }

      return;
    }

    if (kind === "tool_call" || kind === "tool_call_update") {
      this.worked = true;
      this.emitStage("tool");
      this.recordTool(update, now);
    }
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
      // Best-effort activity recording.
    }
  }

  private recordTool(update: Record<string, unknown>, at: number): void {
    const callId =
      typeof update["toolCallId"] === "string"
        ? update["toolCallId"]
        : "unknown";

    const name =
      typeof update["title"] === "string"
        ? update["title"]
        : typeof update["kind"] === "string"
          ? update["kind"]
          : null;

    const rawStatus = update["status"];

    let status: "running" | "completed" | "failed" = "running";

    if (rawStatus === "completed") {
      status = "completed";
    } else if (rawStatus === "failed") {
      status = "failed";
    }

    const input = asRecord(update["rawInput"]) ?? null;

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

            if (name !== null) {
              item.name = name;
            }

            if (input !== null) {
              item.input = input;
            }
          }
        },
      );
    } catch {
      // Best-effort activity recording.
    }
  }
}

async function activateSession(
  conn: AcpStdioConnection,
  spec: AcpRunSpec,
  init: AcpInitializeResult,
  collector: AcpTurnCollector,
  timeoutMs: number,
): Promise<{
  sessionId: string;
  modes: AcpModeState | undefined;
  configOptions: readonly AcpConfigOption[];
}> {
  const meta = spec.sessionMeta?.(init);
  const canLoad = init.agentCapabilities?.loadSession === true;

  const canResume =
    asRecord(init.agentCapabilities?.sessionCapabilities)?.["resume"] !==
    undefined;

  if (spec.nativeSessionId && spec.resumeMethod !== "none") {
    const method =
      spec.resumeMethod === "resume" && (canResume || !canLoad)
        ? "session/resume"
        : canLoad
          ? "session/load"
          : canResume
            ? "session/resume"
            : undefined;

    if (method !== undefined) {
      collector.replaying = true;

      try {
        const resumeParams: Record<string, unknown> = {
          sessionId: spec.nativeSessionId,
          cwd: spec.cwd,
          mcpServers: [],
        };

        if (meta) {
          resumeParams["_meta"] = meta;
        }

        const raw = await requestWithReplayIdle(
          conn,
          method,
          resumeParams,
          collector,
          timeoutMs,
          spec.replayIdleMs ?? DEFAULT_REPLAY_IDLE_MS,
        );

        const parsed = Option.getOrUndefined(decodeSessionResult(raw));

        return {
          sessionId: parsed?.sessionId ?? spec.nativeSessionId,
          modes: parsed?.modes,
          configOptions: parsed?.configOptions ?? [],
        };
      } finally {
        collector.replaying = false;
      }
    }
  }

  const newParams: Record<string, unknown> = {
    cwd: spec.cwd,
    mcpServers: [],
  };

  if (meta) {
    newParams["_meta"] = meta;
  }

  const raw = await conn.request("session/new", newParams, timeoutMs);

  const parsed = Option.getOrUndefined(decodeSessionResult(raw));

  if (!parsed?.sessionId) {
    throw new AcpTransportError("ACP session/new returned no sessionId");
  }

  return {
    sessionId: parsed.sessionId,
    modes: parsed.modes,
    configOptions: parsed.configOptions ?? [],
  };
}

/**
 * Some ACP agents stream replayed history on `session/load` and never send the
 * JSON-RPC response. When replay events arrive and then go quiet for
 * `replayIdleMs`, settle with the known session state.
 */
async function requestWithReplayIdle(
  conn: AcpStdioConnection,
  method: string,
  params: Record<string, unknown>,
  collector: AcpTurnCollector,
  timeoutMs: number,
  replayIdleMs: number,
): Promise<unknown> {
  const rpc = conn.request(method, params, timeoutMs);

  if (method !== "session/load") {
    return rpc;
  }

  const state = { done: false };

  const settled = rpc.finally(() => {
    state.done = true;
  });

  const idleWatch = (async () => {
    const deadline = Date.now() + timeoutMs;

    while (!state.done && Date.now() < deadline) {
      await delay(50);

      if (
        !state.done &&
        collector.replayCount > 0 &&
        Date.now() - collector.lastReplayAt >= replayIdleMs
      ) {
        return {};
      }
    }

    return settled;
  })();

  return Promise.race([settled, idleWatch]);
}

async function applySessionOptions(
  conn: AcpStdioConnection,
  spec: AcpRunSpec,
  sessionId: string,
  modes: AcpModeState | undefined,
  configOptions: readonly AcpConfigOption[],
  timeoutMs: number,
): Promise<void> {
  if (spec.mode !== undefined) {
    const modeId = spec.resolveMode
      ? spec.resolveMode(spec.mode, modes)
      : spec.mode;

    if (modes?.currentModeId !== modeId) {
      await conn.request("session/set_mode", { sessionId, modeId }, timeoutMs);
    }
  }

  const desiredModel = spec.resolveModel
    ? spec.resolveModel(configOptions, spec.model)
    : spec.model;

  if (desiredModel !== undefined) {
    const modelOption = configOptions.find((option) => option.id === "model");

    if (modelOption !== undefined) {
      if (modelOption.currentValue !== desiredModel) {
        await conn.request(
          "session/set_config_option",
          { sessionId, configId: modelOption.id, value: desiredModel },
          timeoutMs,
        );
      }
    } else {
      await conn.request(
        "session/set_model",
        { sessionId, modelId: desiredModel },
        timeoutMs,
      );
    }
  }

  if (spec.reasoningEffort !== undefined) {
    const thoughtOption = configOptions.find(
      (option) =>
        option.category === "thought_level" || option.id === "thought_level",
    );

    if (
      thoughtOption !== undefined &&
      thoughtOption.currentValue !== spec.reasoningEffort
    ) {
      const choices = configSelectValues(thoughtOption);

      if (choices.length === 0 || choices.includes(spec.reasoningEffort)) {
        await conn.request(
          "session/set_config_option",
          {
            sessionId,
            configId: thoughtOption.id,
            value: spec.reasoningEffort,
          },
          timeoutMs,
        );
      }
    }
  }
}

function startActivity(spec: AcpRunSpec): TurnActivityLog | undefined {
  if (!spec.activity) {
    return undefined;
  }

  let links: readonly ActivityRequest[] | undefined;

  try {
    links = spec.activityRequests?.();
  } catch {
    // Best-effort links.
  }

  try {
    return spec.activity.begin(links, spec.sessionId);
  } catch {
    return undefined;
  }
}

function recordProcessStart(
  pid: number | undefined,
  recordPath: string,
  turnMarker: string,
): number {
  let since = 0;

  if (pid === undefined) {
    return since;
  }

  try {
    since = statStart(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    // Non-Linux host.
  }

  writeFileSync(recordPath, JSON.stringify({ pid, turn: turnMarker, since }), {
    mode: 0o600,
  });

  return since;
}

async function teardownConnection(
  conn: AcpStdioConnection,
  turnMarker: string,
  since: number,
  graceMs: number,
  recordPath: string,
): Promise<void> {
  conn.endInput();

  const waitExit = async (ms: number) => {
    const timer = new AbortController();
    await Promise.race([
      conn.done,
      delay(ms, undefined, { signal: timer.signal }).catch(() => {}),
    ]);
    timer.abort();
  };

  await waitExit(Math.min(graceMs, 500));

  if (conn.running) {
    conn.kill("SIGTERM");
    await waitExit(graceMs);
  }

  if (conn.running) {
    conn.kill("SIGKILL");
    await waitExit(graceMs);
  }

  await stopTurnProcesses(
    systemProcesses,
    { variable: acpTurnVariable, value: turnMarker },
    since,
    graceMs,
  );
  await rm(recordPath, { force: true });
}

/** Execute one complete ACP turn in an isolated child process group. */
export async function runAcpTurn(spec: AcpRunSpec): Promise<AcpRunOutcome> {
  spec.signal.throwIfAborted();
  const timeoutMs = spec.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const activity = startActivity(spec);
  const collector = new AcpTurnCollector(spec, activity);

  const child = spawnChild(spec.command, [...spec.args], {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  let since = 0;

  try {
    since = recordProcessStart(child.pid, spec.recordPath, spec.turnMarker);
  } catch (error) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }

    throw error;
  }

  let activeNativeSessionId: string | undefined;
  let promptDispatched = false;
  let conn!: AcpStdioConnection;

  const interceptor = spec.interceptStdoutLine;

  const interceptStdoutLine: AcpLineInterceptor | undefined = interceptor
    ? (line) =>
        interceptor(line, (error) => {
          conn.abortTransport(error);
        })
    : undefined;

  const connectionOptions: AcpStdioConnectionOptions = {
    onNotification: (method, params) => {
      collector.handleNotification(method, params);
    },
    onRequest: (method, params) => {
      if (method === "session/request_permission") {
        if (spec.signal.aborted) {
          return Promise.resolve({ outcome: { outcome: "cancelled" } });
        }

        const decoded = decodePermissionRequest(params);

        if (Option.isSome(decoded)) {
          const outcome = evaluateAcpPermission(
            spec.permissionPolicy,
            spec.cwd,
            spec.extraRoots,
            decoded.value,
          );

          return Promise.resolve({ outcome });
        }

        return Promise.resolve({ outcome: { outcome: "cancelled" } });
      }

      return Promise.reject(
        new Error(`Unsupported ACP client method: ${method}`),
      );
    },
  };

  if (interceptStdoutLine) {
    connectionOptions.interceptStdoutLine = interceptStdoutLine;
  }

  conn = new AcpStdioConnection(child, connectionOptions);

  const onAbort = () => {
    if (promptDispatched && activeNativeSessionId !== undefined) {
      conn.notify("session/cancel", { sessionId: activeNativeSessionId });

      if (spec.cancelBehavior === "interrupt") {
        conn.abortTransport(new AcpTransportError("ACP turn cancelled"));
        conn.kill("SIGTERM");
      } else {
        setTimeout(
          () => {
            conn.abortTransport(new AcpTransportError("ACP cancel timed out"));
            conn.kill("SIGTERM");
          },
          Math.min(spec.graceMs, DEFAULT_CANCEL_TIMEOUT_MS),
        ).unref?.();
      }
    } else {
      conn.abortTransport(new AcpTransportError("ACP startup cancelled"));
      conn.kill("SIGTERM");
    }
  };

  spec.signal.addEventListener("abort", onAbort, { once: true });

  try {
    spec.onProgress?.({
      stage: "submitting",
      observedAt: Date.now(),
      backend: spec.backendTag,
    });

    const rawInit = await conn.request(
      "initialize",
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientInfo: {
          name: "stargate",
          title: "Stargate",
          version: packageJson.version,
        },
        clientCapabilities: clientCapabilitiesFor(spec.flavor),
      },
      timeoutMs,
    );

    const init = Option.getOrElse(decodeInitializeResult(rawInit), () => ({}));

    if (spec.authMethodId !== undefined && spec.authenticateEagerly !== false) {
      await conn.request(
        "authenticate",
        { methodId: spec.authMethodId },
        timeoutMs,
      );
    }

    const session = await activateSession(
      conn,
      spec,
      init,
      collector,
      timeoutMs,
    );

    activeNativeSessionId = session.sessionId;
    await applySessionOptions(
      conn,
      spec,
      session.sessionId,
      session.modes,
      session.configOptions,
      timeoutMs,
    );

    spec.signal.throwIfAborted();
    spec.onProgress?.({
      stage: "model",
      observedAt: Date.now(),
      backend: spec.backendTag,
    });

    promptDispatched = true;

    const rawPrompt = await conn.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: spec.prompt,
    });

    const promptResult = Option.getOrUndefined(decodePromptResult(rawPrompt));

    spec.signal.throwIfAborted();
    collector.endActivity("completed");

    return {
      nativeSessionId: session.sessionId,
      answer: collector.visible(),
      stopReason: promptResult?.stopReason,
    };
  } catch (error) {
    collector.endActivity(spec.signal.aborted ? "cancelled" : "failed");

    if (spec.signal.aborted) {
      throw spec.signal.reason instanceof Error
        ? spec.signal.reason
        : new DOMException("Aborted", "AbortError");
    }

    const ran = collector.worked || collector.visible().length > 0;
    const custom = spec.classifyError?.(error, ran);

    if (custom) {
      throw custom;
    }

    const classified = classifyAcpFailure(error, ran);

    if (classified) {
      throw classified;
    }

    throw error;
  } finally {
    spec.signal.removeEventListener("abort", onAbort);
    await teardownConnection(
      conn,
      spec.turnMarker,
      since,
      spec.graceMs,
      spec.recordPath,
    );
  }
}
