import {
  type ChildProcessByStdio,
  execFile,
  spawn as spawnChild,
} from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type Options,
  type SDKUserMessage,
  type SpawnOptions,
  type SpawnedProcess,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import { Option, Schema } from "effect";
import {
  type Attachment,
  checkAttachments,
} from "../chat/attachments/attachments";
import {
  type AgentBackend,
  type BackendContext,
  type PromptSourceContext,
  type TextSink,
  sourceLine,
} from "./backend";
import type { claudeBackendSchema } from "./claude/config";
import { secret } from "../lib/credentials";
import {
  compareVersions,
  parseVersion,
} from "../automation/maintenance/nightly/update/versions";
import {
  AttachmentInputUnavailable,
  BackendFailure,
  type BackendFailureKind,
  statusKind,
} from "../shared/request-failure";
import type { TurnProgress, TurnStage } from "../shared/turn-progress";
import {
  inherited,
  isTextAttachment,
  statStart,
  stopTurnGroup,
  stopTurnProcesses,
  systemProcesses,
  textAttachment,
} from "./cli-agent";

type Config = typeof claudeBackendSchema.Type;

type UserContent = Exclude<SDKUserMessage["message"]["content"], string>;

/** Fixed, safe failure text produced by this adapter. */
class ClaudeTurnError extends Error {}

const exec = promisify(execFile);
const versionFailure = "Cannot verify Claude Code version for MCP delivery";
const sdkMetadata = Schema.Struct({ claudeCodeVersion: Schema.String });

/** Resolve from the SDK, never PATH, using its native platform preference. */
function claudeCLI() {
  const entry = import.meta.resolve("@anthropic-ai/claude-agent-sdk");
  const require = createRequire(entry);
  const root = dirname(fileURLToPath(entry));

  const { claudeCodeVersion } = Schema.decodeUnknownSync(sdkMetadata)(
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
  );

  if (!parseVersion(claudeCodeVersion)) {
    throw new ClaudeTurnError(versionFailure);
  }

  const native = () => {
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
        const path = require.resolve(
          `@anthropic-ai/claude-agent-sdk-${target}/claude${process.platform === "win32" ? ".exe" : ""}`,
        );

        if (existsSync(path)) {
          return path;
        }
      } catch {
        // This platform package is not installed; try the next candidate.
      }
    }

    throw new ClaudeTurnError(versionFailure);
  };

  return { version: claudeCodeVersion, native };
}

// A CLI that ends without a result proves nothing about its tools: frames
// Can be lost with the process. Never report that nothing ran.
const crashed = { ran: true } as const;

/** Claude session IDs are UUIDs; anything else never reaches the filesystem. */
const maximumSessionID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

const sessionIDSchema = Schema.String.check(
  Schema.isUUID(),
  // Zod accepted the max UUID only in lowercase; preserve existing ID spelling.
  Schema.makeFilter(
    (id) => id.toLowerCase() !== maximumSessionID || id === maximumSessionID,
  ),
);

const isSessionID = Schema.is(sessionIDSchema);

/**
 * Non-secret routing variables. They are also passed as flag settings, the
 * highest settings layer below managed policy, so project or local settings
 * cannot redirect the endpoint (and its key) or select another model.
 */
export function claudeRouting(config: Config): Record<string, string> {
  const model = config.model;

  return {
    ANTHROPIC_BASE_URL: config.provider.baseURL.slice(0, -"/v1".length),
    // Background, subagent and alias requests must not pick another model.
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    // Direct connections only; no inherited or configured HTTP proxy.
    NO_PROXY: "*",
    // No telemetry, error reports, update checks or other optional traffic.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  };
}

/**
 * The complete child environment. `CLAUDE_CONFIG_DIR` keeps settings,
 * sessions and any credentials store private to this backend namespace, so
 * the host's `~/.claude` login is never used. The proxy key travels as a
 * bearer token and only in the environment, never in arguments.
 */
export function claudeEnvironment(
  config: Config,
  configDirectory: string,
  parent: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    ...inherited(parent),
    ...claudeRouting(config),
    CLAUDE_CONFIG_DIR: configDirectory,
    ANTHROPIC_AUTH_TOKEN: secret(config.provider.apiKeyEnv, parent),
    CLAUDE_AGENT_SDK_CLIENT_APP: "stargate",
  };
}

const imageTypes = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

/** Images, PDFs and UTF-8 text become content blocks; other files fail. */
export function claudeInputContent(
  text: string,
  files: readonly Attachment[],
): string | UserContent {
  try {
    checkAttachments(files);
  } catch {
    throw new AttachmentInputUnavailable(
      "Invalid or oversized Claude attachments",
    );
  }

  if (files.length === 0) {
    return text;
  }

  const content: UserContent = [];

  if (text) {
    content.push({ type: "text", text });
  }

  for (const file of files) {
    const data = Buffer.from(file.data).toString("base64");
    const image = imageTypes.find((type) => type === file.mime);

    if (image) {
      content.push(
        { type: "text", text: `Attachment: ${file.name}` },
        {
          type: "image",
          source: { type: "base64", media_type: image, data },
        },
      );
    } else if (file.mime === "application/pdf") {
      content.push({
        type: "document",
        title: file.name,
        source: { type: "base64", media_type: "application/pdf", data },
      });
    } else if (isTextAttachment(file)) {
      content.push({ type: "text", text: textAttachment(file) });
    } else {
      throw new AttachmentInputUnavailable(
        "Claude supports UTF-8 text, PDF and PNG/JPEG/GIF/WebP attachments only",
      );
    }
  }

  return content;
}

// Only main-thread frames count; subagent frames carry a parent tool ID.
const streamFrame = Schema.Struct({
  type: Schema.Literal("stream_event"),
  parent_tool_use_id: Schema.Null,
  event: Schema.Unknown,
});

const streamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("message_start"),
    message: Schema.Struct({ id: Schema.String }),
  }),
  Schema.Struct({
    type: Schema.Literal("content_block_start"),
    index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    content_block: Schema.Struct({
      type: Schema.String,
      text: Schema.optional(Schema.String),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("content_block_delta"),
    index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    delta: Schema.Struct({
      type: Schema.String,
      text: Schema.optional(Schema.String),
    }),
  }),
]);

const assistantFrame = Schema.Struct({
  type: Schema.Literal("assistant"),
  parent_tool_use_id: Schema.Null,
  message: Schema.Struct({
    id: Schema.String,
    content: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        text: Schema.optional(Schema.String),
      }),
    ),
  }),
  error: Schema.optional(Schema.String),
});

const initFrame = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("init"),
  session_id: Schema.String,
});

const resultFrame = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.String,
  is_error: Schema.Boolean,
  result: Schema.optional(Schema.String),
  api_error_status: Schema.optional(Schema.NullOr(Schema.Finite)),
});

// Any frame of a tool call: this turn did work.
const toolFrame = Schema.Union([
  Schema.Struct({ parent_tool_use_id: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("assistant"),
    message: Schema.Struct({
      content: Schema.Array(Schema.Struct({ type: Schema.String })).check(
        Schema.makeFilter((blocks) =>
          blocks.some((block) => block.type === "tool_use"),
        ),
      ),
    }),
  }),
]);

const decodeStreamFrame = Schema.decodeUnknownOption(streamFrame);
const decodeStreamEvent = Schema.decodeUnknownOption(streamEvent);
const decodeAssistantFrame = Schema.decodeUnknownOption(assistantFrame);
const decodeInitFrame = Schema.decodeUnknownOption(initFrame);
const decodeResultFrame = Schema.decodeUnknownOption(resultFrame);
const isToolFrame = Schema.is(toolFrame);

/** Fixed causes only; raw SDK, CLI and provider text never leaves here. */
const knownCauses = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "cloud_credential_error",
  "billing_error",
  "rate_limit",
  "overloaded",
  "invalid_request",
  "model_not_found",
  "server_error",
  "max_output_tokens",
  "error_during_execution",
  "error_max_turns",
  "error_max_budget_usd",
]);

/** The SDK's fixed provider causes and their shared category. */
const causeKinds: Record<string, BackendFailureKind> = {
  authentication_failed: "auth",
  oauth_org_not_allowed: "auth",
  account_on_hold: "auth",
  verification_required: "auth",
  cloud_credential_error: "auth",
  billing_error: "quota",
  rate_limit: "quota",
  model_not_found: "model",
  overloaded: "provider",
  server_error: "provider",
  invalid_request: "provider",
};

/**
 * The shared category of a failed turn, or undefined when the CLI reported
 * no provider failure (for example a turn limit). A specific HTTP status
 * (429, 401, 404, 504) wins over the SDK's cause.
 */
export function claudeFailure(turn: ClaudeTurn): BackendFailure | undefined {
  if (!turn.result || turn.result.ok) {
    return undefined;
  }

  const { cause, status } = turn.result;
  const byStatus = status === undefined ? undefined : statusKind(status);

  const kind =
    byStatus && byStatus !== "provider"
      ? byStatus
      : (causeKinds[cause] ?? byStatus);

  return kind && new BackendFailure(kind, { status, ran: turn.worked });
}

/**
 * Visible text of one turn: main-thread assistant text blocks only, never
 * thinking, tool input or tool results. Previews use streamed deltas; the
 * answer uses completed assistant messages.
 */
export class ClaudeTurn {
  private readonly order: string[] = [];
  private readonly streamed = new Map<string, Map<number, string>>();
  private readonly complete = new Map<string, string[]>();
  private streaming: string | undefined;
  private failure: string | undefined;
  public session: string | undefined;
  /** A tool call was seen: the turn may have changed something. */
  public worked = false;
  public result:
    | { ok: true; text: string }
    | { ok: false; cause: string; status?: number }
    | undefined;

  /** Returns true when the visible text may have changed. */
  public add(raw: unknown, stage?: (stage: TurnStage) => void): boolean {
    if (isToolFrame(raw)) {
      this.worked = true;
    }

    const init = decodeInitFrame(raw);

    if (Option.isSome(init)) {
      this.session = init.value.session_id;

      return false;
    }

    const frame = decodeStreamFrame(raw);

    if (Option.isSome(frame)) {
      return this.addStreamEvent(frame.value.event, stage);
    }

    const assistant = decodeAssistantFrame(raw);

    if (Option.isSome(assistant)) {
      const id = assistant.value.message.id;

      if (assistant.value.error) {
        // Error text can quote the provider; only the fixed cause is kept.
        this.failure = assistant.value.error;
        const shown = this.streamed.has(id) || this.complete.has(id);
        this.streamed.delete(id);
        this.complete.delete(id);

        return shown;
      }

      this.seen(id);

      const texts = assistant.value.message.content.flatMap((block) =>
        block.type === "text" && block.text ? [block.text] : [],
      );

      if (texts.length === 0) {
        return false;
      }

      this.complete.set(id, [...(this.complete.get(id) ?? []), ...texts]);

      return true;
    }

    const result = decodeResultFrame(raw);

    if (Option.isSome(result)) {
      const { subtype, is_error } = result.value;

      if (subtype === "success" && !is_error) {
        this.result = { ok: true, text: result.value.result ?? "" };
      } else {
        const cause = this.failure ?? subtype;
        const status = result.value.api_error_status;
        this.result = {
          ok: false,
          cause: knownCauses.has(cause) ? cause : "error",
          ...(typeof status === "number" && { status }),
        };
      }
    }

    return false;
  }

  private addStreamEvent(raw: unknown, stage?: (stage: TurnStage) => void) {
    const event = decodeStreamEvent(raw);

    if (Option.isNone(event)) {
      return false;
    }

    if (event.value.type === "message_start") {
      stage?.("model");
      this.streaming = event.value.message.id;
      this.seen(this.streaming);

      if (!this.streamed.has(this.streaming)) {
        this.streamed.set(this.streaming, new Map());
      }

      return false;
    }

    const blocks = this.streaming && this.streamed.get(this.streaming);

    if (blocks === undefined || blocks === "") {
      return false;
    }

    if (event.value.type === "content_block_start") {
      const kind = event.value.content_block.type;

      if (kind === "thinking" || kind === "redacted_thinking") {
        stage?.("reasoning");
      }

      if (kind === "tool_use" || kind === "server_tool_use") {
        stage?.("tool");
      }

      if (kind !== "text") {
        return false;
      }

      stage?.("reply");
      blocks.set(event.value.index, event.value.content_block.text ?? "");

      return true;
    }

    if (event.value.delta.type !== "text_delta" || !event.value.delta.text) {
      return false;
    }

    blocks.set(
      event.value.index,
      (blocks.get(event.value.index) ?? "") + event.value.delta.text,
    );

    return true;
  }

  private seen(id: string) {
    if (!this.order.includes(id)) {
      this.order.push(id);
    }
  }

  public visible(): string {
    return this.order
      .map((id) => {
        const blocks = this.streamed.get(id);

        const streamed = blocks
          ? [...blocks]
              .toSorted(([a], [b]) => a - b)
              .values()
              .map(([, text]) => text)
              .filter(Boolean)
              .toArray()
              .join("\n")
          : "";

        return streamed || (this.complete.get(id) ?? []).join("\n");
      })
      .filter(Boolean)
      .join("\n\n");
  }

  public answer(): string {
    const text = this.order
      .map((id) => (this.complete.get(id) ?? []).join("\n"))
      .filter(Boolean)
      .join("\n\n");

    return text || (this.result?.ok ? this.result.text : "");
  }
}

/** The turn marker variable of Claude Code children; see `TurnMarker`. */
const turnVariable = "STARGATE_CLAUDE_TURN";

/** One spawned Claude Code CLI in its own process group. */
class ClaudeProcess implements SpawnedProcess {
  private signalled = false;
  public readonly exited: Promise<void>;

  public constructor(
    private readonly child: ChildProcessByStdio<Writable, Readable, null>,
  ) {
    this.exited = new Promise((resolve) => {
      child.once("exit", () => {
        resolve();
      });
      child.once("error", () => {
        resolve();
      });
    });
  }

  public get stdin() {
    return this.child.stdin;
  }
  public get stdout() {
    return this.child.stdout;
  }
  public get killed() {
    return this.signalled || this.child.killed;
  }
  public get exitCode() {
    return this.child.exitCode;
  }
  public get signalCode() {
    return this.child.signalCode;
  }
  public get running() {
    return this.child.exitCode === null && this.child.signalCode === null;
  }
  /**
   * Signal the CLI's whole group while the CLI is Stargate's unreaped child: its
   * PID, and so its group ID, cannot be reused before Stargate reaps it.
   */
  public kill(signal: NodeJS.Signals) {
    if (!this.running) {
      return false;
    }

    this.signalled = true;

    try {
      if (this.child.pid === undefined) {
        return false;
      }

      process.kill(-this.child.pid, signal);

      return true;
    } catch {
      return this.child.kill(signal);
    }
  }

  public on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  public on(event: "error", listener: (error: Error) => void): void;
  public on(
    event: "exit" | "error",
    listener:
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void),
  ) {
    this.child.on(event, listener);
  }

  public once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  public once(event: "error", listener: (error: Error) => void): void;
  public once(
    event: "exit" | "error",
    listener:
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void),
  ) {
    this.child.once(event, listener);
  }

  public off(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  public off(event: "error", listener: (error: Error) => void): void;
  public off(
    event: "exit" | "error",
    listener:
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void),
  ) {
    this.child.off(event, listener);
  }
}

type Run = {
  controller: AbortController;
  process?: ClaudeProcess;
  done: Promise<void>;
  /** Value of the turn marker in every process this turn starts. */
  turn: string;
  /** Start time of the CLI; marked processes cannot be older. */
  since: number;
  record: string;
};

/** A running CLI, kept on disk so a later process can stop what it left. */
const recordSchema = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  turn: sessionIDSchema,
  since: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const decodeRecord = Schema.decodeUnknownSync(recordSchema, {
  onExcessProperty: "error",
});

/**
 * Test seams: a fake CLI path (production uses the SDK's native binary),
 * the version-probe deadline and the SIGTERM-to-SIGKILL grace period.
 */
export type ClaudeRuntime = {
  executable?: string;
  graceMs?: number;
  versionTimeoutMs?: number;
};

export class ClaudeBackend implements AgentBackend {
  public readonly supportsAttachments = true;
  private readonly runs = new Map<string, Run>();
  /** Titles for sessions whose first turn has not started in this process. */
  private readonly titles = new Map<string, string>();
  private closed = false;

  private constructor(
    private readonly config: Config,
    /** `CLAUDE_CONFIG_DIR`: sessions, settings and caches of this namespace. */
    private readonly home: string,
    /** PID records of running CLIs, for restart recovery. */
    private readonly records: string,
    private readonly runtime: ClaudeRuntime,
  ) {}

  private get grace() {
    return this.runtime.graceMs ?? 5000;
  }

  public static async open(
    config: Config,
    context: BackendContext,
    runtime: ClaudeRuntime = {},
  ) {
    // Fail at startup, not on the first turn, when the key is missing.
    secret(config.provider.apiKeyEnv);
    const home = join(context.dataDirectory, "claude");
    const records = join(context.dataDirectory, "claude-runs");

    for (const directory of [home, records]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }

    return new ClaudeBackend(config, home, records, runtime);
  }

  public async createSession({
    title,
    signal,
  }: Parameters<AgentBackend["createSession"]>[0]) {
    signal.throwIfAborted();

    if (this.closed) {
      throw new Error("Claude backend is closing");
    }

    // The first turn creates the native session with this ID.
    const id = crypto.randomUUID();
    this.titles.set(id, title);

    return id;
  }

  /** A transcript in this namespace proves the native session exists. */
  private async started(id: string) {
    const projects = join(this.home, "projects");
    let directories: string[];

    try {
      directories = await readdir(projects);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }

      throw error;
    }

    for (const directory of directories) {
      try {
        await access(join(projects, directory, `${id}.jsonl`));

        return true;
      } catch {
        // Not in this project directory; check the next one.
      }
    }

    return false;
  }

  public async prompt(
    sessionId: string,
    text: string,
    signal: AbortSignal,
    onText?: TextSink,
    onInput?: (id: string) => void,
    files: readonly Attachment[] = [],
    context?: PromptSourceContext,
    onProgress?: (value: TurnProgress) => void,
  ): Promise<string> {
    const stage = onProgress
      ? (value: TurnStage) => {
          onProgress({
            stage: value,
            observedAt: Date.now(),
            backend: "claude",
          });
        }
      : undefined;

    signal.throwIfAborted();

    if (this.closed) {
      throw new Error("Claude backend is closing");
    }

    if (!isSessionID(sessionId)) {
      throw new ClaudeTurnError("Claude session ID is not valid");
    }

    const id = sessionId;

    if (this.runs.has(id)) {
      throw new ClaudeTurnError("Claude session is busy");
    }

    const content = claudeInputContent(
      context ? `${sourceLine(context)}\n\n${text}` : text,
      files,
    );

    const env = claudeEnvironment(this.config, this.home);
    let temporary: string | undefined;

    const run: Run = {
      controller: new AbortController(),
      done: Promise.resolve(),
      turn: crypto.randomUUID(),
      since: 0,
      record: join(this.records, `${id}.json`),
    };

    env[turnVariable] = run.turn;
    this.runs.set(id, run);
    const finished = Promise.withResolvers<void>();
    run.done = finished.promise;

    const stop = () => {
      run.controller.abort();
      run.process?.kill("SIGTERM");
    };

    signal.addEventListener("abort", stop, { once: true });

    try {
      // Never resume a session that an earlier process is still running.
      await this.stopOrphan(id, AbortSignal.timeout(5000));
      let executable: string;
      let mcpServersDelivery: "initialize" | "argv" = "initialize";

      try {
        const bundled = claudeCLI();
        executable = this.runtime.executable ?? bundled.native();

        const { stdout } = await exec(executable, ["--version"], {
          cwd: this.config.directory,
          env: {
            ...inherited(process.env),
            ...claudeRouting(this.config),
            CLAUDE_CONFIG_DIR: this.home,
          },
          signal: run.controller.signal,
          timeout: this.runtime.versionTimeoutMs ?? 5000,
          killSignal: "SIGKILL",
          maxBuffer: 4096,
        });

        const version = /^(\S+)(?: \(Claude Code\))?$/.exec(stdout.trim())?.[1];

        if (!version || !parseVersion(version)) {
          throw new ClaudeTurnError(versionFailure);
        }

        if (compareVersions(version, bundled.version) < 0) {
          mcpServersDelivery = "argv";

          if (Object.keys(this.config.mcpServers ?? {}).length > 0) {
            process.emitWarning(
              "Claude Code is older than the SDK bundled CLI; using MCP argv delivery. MCP environment and headers may be visible to other local users. Update Claude Code to use initialize delivery.",
              { code: "STARGATE_CLAUDE_MCP_ARGV_FALLBACK" },
            );
          }
        }
      } catch {
        // Probe output and command errors can contain secrets; discard both.
        throw new ClaudeTurnError(versionFailure);
      }

      run.controller.signal.throwIfAborted();
      // A private temporary directory per turn, removed after the CLI exits.
      temporary = await mkdtemp(join(tmpdir(), "stargate-claude-"));
      env["TMPDIR"] = temporary;
      const resume = await this.started(id);
      signal.throwIfAborted();
      const input = crypto.randomUUID();
      onInput?.(input);
      const title = this.titles.get(id);
      this.titles.delete(id);
      const answered = Promise.withResolvers<void>();

      const message: SDKUserMessage = {
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
        uuid: input,
      };

      const messages = async function* () {
        yield message;
        // Closing input after the result lets the CLI exit cleanly.
        await answered.promise;
      };

      const options: Options = {
        abortController: run.controller,
        cwd: this.config.directory,
        model: this.config.model,
        env,
        // Built-ins and explicit MCP servers are separate permissions.
        tools: [...this.config.allowedTools],
        allowedTools: [
          ...this.config.allowedTools,
          ...Object.keys(this.config.mcpServers ?? {}).map(
            (name) => `mcp__${name}`,
          ),
        ],
        permissionMode: "dontAsk",
        permissionPrompts: "none",
        settingSources: this.config.settingSources,
        // Loaded settings cannot run hooks or change the routing variables.
        settings: { env: claudeRouting(this.config), disableAllHooks: true },
        mcpServers: Object.fromEntries(
          Object.entries(this.config.mcpServers ?? {}).map(([name, server]) => [
            name,
            { ...server, alwaysLoad: true },
          ]),
        ),
        mcpServersDelivery,
        strictMcpConfig: true,
        // Slack text is data: no @file expansion or slash-command dispatch.
        verbatimPrompts: true,
        includePartialMessages:
          onText !== undefined || onProgress !== undefined,
        maxTurns: this.config.maxTurns,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          ...(this.config.systemPrompt && { append: this.config.systemPrompt }),
        },
        ...(this.config.effort && { effort: this.config.effort }),
        ...(resume
          ? { resume: id }
          : { sessionId: id, ...(title && { title }) }),
        pathToClaudeCodeExecutable: executable,
        spawnClaudeCodeProcess: (spawn) => this.spawn(run, spawn),
      };

      const turn = new ClaudeTurn();
      let settle: ReturnType<typeof setTimeout> | undefined;

      try {
        for await (const frame of query({ prompt: messages(), options })) {
          const changed = turn.add(frame, stage);

          if (turn.session !== undefined && turn.session !== id) {
            throw new ClaudeTurnError("Claude session identity changed");
          }

          if (changed && onText) {
            const visible = turn.visible();

            if (visible) {
              onText(visible);
            }
          }

          if (turn.result && !settle) {
            answered.resolve();
            // Background work can keep the CLI alive; it ends with the turn.
            settle = setTimeout(stop, this.grace);
          }
        }
      } catch (error) {
        // The result completes the turn; a later teardown error does not.
        if (signal.aborted) {
          throw error;
        }

        // The CLI ended without a result. SDK errors can carry CLI output.
        if (!turn.result) {
          throw new BackendFailure("crash", crashed);
        }
      } finally {
        clearTimeout(settle);
        answered.resolve();
      }

      signal.throwIfAborted();

      if (!turn.result) {
        throw new BackendFailure("crash", crashed);
      }

      if (!turn.result.ok) {
        throw (
          claudeFailure(turn) ??
          new ClaudeTurnError(`Claude turn failed: ${turn.result.cause}`)
        );
      }

      return turn.answer();
    } catch (error) {
      // A failed turn must not leave its CLI running.
      stop();
      signal.throwIfAborted();

      if (
        error instanceof AttachmentInputUnavailable ||
        error instanceof BackendFailure ||
        error instanceof ClaudeTurnError
      ) {
        throw error;
      }

      // SDK errors can carry CLI output or request details; never forward them.
      throw new ClaudeTurnError("Claude turn failed");
    } finally {
      signal.removeEventListener("abort", stop);
      await this.finish(run);

      if (temporary) {
        await rm(temporary, { recursive: true, force: true }).catch(() => {});
      }

      if (this.runs.get(id) === run) {
        this.runs.delete(id);
      }

      finished.resolve();
    }
  }

  private spawn(run: Run, options: SpawnOptions): SpawnedProcess {
    const child = spawnChild(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      // CLI diagnostics can contain request details; they are not logged.
      stdio: ["pipe", "pipe", "ignore"],
      detached: true,
    });

    const cli = new ClaudeProcess(child);
    run.process = cli;

    if (child.pid !== undefined) {
      try {
        run.since = statStart(readFileSync(`/proc/${child.pid}/stat`, "utf8"));
      } catch {
        // Not Linux: there is no marker scan to bound.
      }

      // Removed in finish(), after everything the turn started has stopped.
      writeFileSync(
        run.record,
        JSON.stringify({ pid: child.pid, turn: run.turn, since: run.since }),
        { mode: 0o600 },
      );
    }

    options.signal.addEventListener("abort", () => cli.kill("SIGTERM"), {
      once: true,
    });

    if (run.controller.signal.aborted) {
      cli.kill("SIGTERM");
    }

    return cli;
  }

  /**
   * Wait for the CLI to exit, stopping its group when it does not, then stop
   * every verified process of the turn that is still left.
   */
  private async finish(run: Run) {
    const cli = run.process;

    if (!cli) {
      return;
    }

    const exited = async () => {
      const grace = new AbortController();
      await Promise.race([
        cli.exited,
        delay(this.grace, undefined, { signal: grace.signal }).catch(() => {}),
      ]);
      grace.abort();
    };

    await exited();

    if (cli.running) {
      run.controller.abort();
      cli.kill("SIGTERM");
      await exited();
      cli.kill("SIGKILL");
    }

    await cli.exited;
    await stopTurnProcesses(
      systemProcesses,
      { variable: turnVariable, value: run.turn },
      run.since,
      this.grace,
    );
    await rm(run.record, { force: true });
  }

  /**
   * Stop what a turn of an earlier Stargate process left running. Its group is
   * signalled only while the recorded CLI verifiably leads it; other
   * processes only while their start time, user and marker match. Linux
   * only; elsewhere nothing is signalled.
   */
  private async stopOrphan(id: string, signal: AbortSignal) {
    if (this.runs.get(id)?.process) {
      return;
    }

    const path = join(this.records, `${id}.json`);
    let record: typeof recordSchema.Type;

    try {
      record = decodeRecord(JSON.parse(await readFile(path, "utf8")));
    } catch {
      return;
    }

    const marker = { variable: turnVariable, value: record.turn };

    const leader = {
      pid: record.pid,
      start: record.since,
      marker,
      session: id,
    };

    await stopTurnGroup(systemProcesses, leader, this.grace, signal);
    await stopTurnProcesses(
      systemProcesses,
      marker,
      record.since,
      this.grace,
      signal,
    );
    await rm(path, { force: true });
  }

  public async interrupt(sessionId: string, signal: AbortSignal) {
    if (!isSessionID(sessionId)) {
      return;
    }

    const run = this.runs.get(sessionId);

    if (run) {
      run.controller.abort();
      run.process?.kill("SIGTERM");
      await run.done;

      return;
    }

    await this.stopOrphan(sessionId, signal);
  }

  public async close() {
    this.closed = true;
    const runs = [...this.runs.values()];

    for (const run of runs) {
      run.controller.abort();
      run.process?.kill("SIGTERM");
    }

    await Promise.all(runs.map((run) => run.done));
  }
}
