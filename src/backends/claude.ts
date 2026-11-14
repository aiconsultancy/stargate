import {
  type ChildProcessByStdio,
  spawn as spawnChild,
} from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  type Options,
  query,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { type Attachment, checkAttachments } from "../attachments";
import {
  type AgentBackend,
  type BackendContext,
  type PromptSourceContext,
  sourceLine,
  type TextSink,
} from "../backend";
import { type BackendConfig, secret } from "../config";
import { AttachmentInputUnavailable } from "../request-failure";

type Config = Extract<BackendConfig, { type: "claude" }>;
type UserContent = Exclude<SDKUserMessage["message"]["content"], string>;

/** Fixed, safe failure text produced by this adapter. */
class ClaudeTurnError extends Error {}

/** Claude session IDs are UUIDs; anything else never reaches the filesystem. */
const sessionIDSchema = z.uuid();

/**
 * Non-secret variables the Claude Code child inherits. Everything else in
 * Pogo's environment, including Slack tokens and provider keys, is dropped.
 */
export const claudeInheritedEnvironment = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
] as const;

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
  const env: Record<string, string> = {};
  for (const name of claudeInheritedEnvironment) {
    const value = parent[name];
    if (value) env[name] = value;
  }
  return {
    ...env,
    ...claudeRouting(config),
    CLAUDE_CONFIG_DIR: configDirectory,
    ANTHROPIC_AUTH_TOKEN: secret(config.provider.apiKeyEnv, parent),
    CLAUDE_AGENT_SDK_CLIENT_APP: "pogo",
  };
}

const imageTypes = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;
const textTypes = [
  "application/json",
  "application/xml",
  "application/yaml",
  "application/javascript",
];

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
  if (!files.length) return text;
  const content: UserContent = [];
  if (text) content.push({ type: "text", text });
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
    } else if (file.mime.startsWith("text/") || textTypes.includes(file.mime)) {
      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(file.data);
      } catch {
        throw new AttachmentInputUnavailable(
          "Claude text attachments require valid UTF-8",
        );
      }
      if (
        file.data.some(
          (byte) =>
            byte === 127 ||
            (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13),
        )
      )
        throw new AttachmentInputUnavailable(
          "Claude text attachment contains binary control bytes",
        );
      content.push({
        type: "text",
        text: `Attachment: ${file.name}\n${decoded}`,
      });
    } else {
      throw new AttachmentInputUnavailable(
        "Claude supports UTF-8 text, PDF and PNG/JPEG/GIF/WebP attachments only",
      );
    }
  }
  return content;
}

// Only main-thread frames count; subagent frames carry a parent tool ID.
const streamFrame = z.object({
  type: z.literal("stream_event"),
  parent_tool_use_id: z.null(),
  event: z.unknown(),
});
const streamEvent = z.union([
  z.object({
    type: z.literal("message_start"),
    message: z.object({ id: z.string() }),
  }),
  z.object({
    type: z.literal("content_block_start"),
    index: z.number().int().nonnegative(),
    content_block: z.object({ type: z.string(), text: z.string().optional() }),
  }),
  z.object({
    type: z.literal("content_block_delta"),
    index: z.number().int().nonnegative(),
    delta: z.object({ type: z.string(), text: z.string().optional() }),
  }),
]);
const assistantFrame = z.object({
  type: z.literal("assistant"),
  parent_tool_use_id: z.null(),
  message: z.object({
    id: z.string(),
    content: z.array(
      z.object({ type: z.string(), text: z.string().optional() }),
    ),
  }),
  error: z.string().optional(),
});
const initFrame = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string(),
});
const resultFrame = z.object({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
});

/** Fixed causes only; raw SDK, CLI and provider text never leaves here. */
const knownCauses = new Set([
  "authentication_failed",
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
  session: string | undefined;
  result: { ok: true; text: string } | { ok: false; cause: string } | undefined;

  /** Returns true when the visible text may have changed. */
  add(raw: unknown): boolean {
    const init = initFrame.safeParse(raw);
    if (init.success) {
      this.session = init.data.session_id;
      return false;
    }
    const frame = streamFrame.safeParse(raw);
    if (frame.success) {
      const event = streamEvent.safeParse(frame.data.event);
      if (!event.success) return false;
      if (event.data.type === "message_start") {
        this.streaming = event.data.message.id;
        this.seen(this.streaming);
        if (!this.streamed.has(this.streaming))
          this.streamed.set(this.streaming, new Map());
        return false;
      }
      const blocks = this.streaming && this.streamed.get(this.streaming);
      if (!blocks) return false;
      if (event.data.type === "content_block_start") {
        if (event.data.content_block.type !== "text") return false;
        blocks.set(event.data.index, event.data.content_block.text ?? "");
        return true;
      }
      if (event.data.delta.type !== "text_delta" || !event.data.delta.text)
        return false;
      blocks.set(
        event.data.index,
        (blocks.get(event.data.index) ?? "") + event.data.delta.text,
      );
      return true;
    }
    const assistant = assistantFrame.safeParse(raw);
    if (assistant.success) {
      const id = assistant.data.message.id;
      if (assistant.data.error) {
        // Error text can quote the provider; only the fixed cause is kept.
        this.failure = assistant.data.error;
        const shown = this.streamed.has(id) || this.complete.has(id);
        this.streamed.delete(id);
        this.complete.delete(id);
        return shown;
      }
      this.seen(id);
      const texts = assistant.data.message.content.flatMap((block) =>
        block.type === "text" && block.text ? [block.text] : [],
      );
      if (!texts.length) return false;
      this.complete.set(id, [...(this.complete.get(id) ?? []), ...texts]);
      return true;
    }
    const result = resultFrame.safeParse(raw);
    if (result.success) {
      const { subtype, is_error } = result.data;
      if (subtype === "success" && !is_error)
        this.result = { ok: true, text: result.data.result ?? "" };
      else {
        const cause = this.failure ?? subtype;
        this.result = {
          ok: false,
          cause: knownCauses.has(cause) ? cause : "error",
        };
      }
    }
    return false;
  }

  private seen(id: string) {
    if (!this.order.includes(id)) this.order.push(id);
  }

  visible(): string {
    return this.order
      .map((id) => {
        const blocks = this.streamed.get(id);
        const streamed = blocks
          ? [...blocks]
              .sort(([a], [b]) => a - b)
              .map(([, text]) => text)
              .filter(Boolean)
              .join("\n")
          : "";
        return streamed || (this.complete.get(id) ?? []).join("\n");
      })
      .filter(Boolean)
      .join("\n\n");
  }

  answer(): string {
    const text = this.order
      .map((id) => (this.complete.get(id) ?? []).join("\n"))
      .filter(Boolean)
      .join("\n\n");
    return text || (this.result?.ok ? this.result.text : "");
  }
}

/**
 * Every process of a turn inherits this variable with a random value. Claude
 * Code runs Bash commands in their own sessions, outside the CLI's process
 * group, so the marker is how Pogo finds what a turn left behind.
 */
const turnVariable = "POGO_CLAUDE_TURN";

/**
 * The Linux process table: `/proc`, this process's user ID and `kill`. Tests
 * use a fake root to simulate PID reuse.
 */
export type ProcessTable = {
  root: string;
  uid: number | undefined;
  kill(pid: number, signal: NodeJS.Signals): void;
};
const systemProcesses: ProcessTable = {
  root: "/proc",
  uid: process.getuid?.(),
  kill: (pid, signal) => process.kill(pid, signal),
};

/** A process found for a turn: its PID and start time pin its identity. */
export type TurnProcess = { pid: number; start: number };
/** A recorded CLI: the leader of its process group. */
export type TurnLeader = TurnProcess & { turn: string; session: string };

/** Start time in clock ticks since boot: field 22 of `/proc/<pid>/stat`. */
function statStart(stat: string) {
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
}

/** Start time, process group (field 5) and the four user IDs. */
function facts(stat: string, status: string) {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const start = Number(fields[19]);
  const group = Number(fields[2]);
  const uids = /^Uid:[ \t]+(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(group) || !uids)
    return undefined;
  return { start, group, uids };
}

/** Real, effective, saved and filesystem user IDs are all Pogo's own. */
function owned(table: ProcessTable, uids: readonly string[]) {
  return (
    table.uid !== undefined &&
    uids.length === 4 &&
    uids.every((uid) => uid === String(table.uid))
  );
}

function carries(environ: Buffer, turn: string) {
  return Buffer.concat([Buffer.from([0]), environ]).includes(
    Buffer.from(`\0${turnVariable}=${turn}\0`),
  );
}

/** One process's facts and environment, read now and synchronously. */
function inspect(table: ProcessTable, pid: number) {
  try {
    const base = join(table.root, String(pid));
    const known = facts(
      readFileSync(join(base, "stat"), "utf8"),
      readFileSync(join(base, "status"), "utf8"),
    );
    return known && { ...known, environ: readFileSync(join(base, "environ")) };
  } catch {
    return undefined;
  }
}

/**
 * Processes of Pogo's user that started at or after `since` and carry the
 * turn marker. Linux only: without `/proc` nothing is found.
 */
export async function turnProcesses(
  table: ProcessTable,
  turn: string,
  since: number,
): Promise<TurnProcess[]> {
  let entries: string[];
  try {
    entries = await readdir(table.root);
  } catch {
    return [];
  }
  const found: TurnProcess[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) return;
      try {
        const base = join(table.root, entry);
        const known = facts(
          await readFile(join(base, "stat"), "utf8"),
          await readFile(join(base, "status"), "utf8"),
        );
        if (!known || known.start < since || !owned(table, known.uids)) return;
        if (carries(await readFile(join(base, "environ")), turn))
          found.push({ pid: Number(entry), start: known.start });
      } catch {
        // Gone, or not readable by this user.
      }
    }),
  );
  return found.sort((a, b) => a.pid - b.pid);
}

/**
 * Signal each process only while it is still the one that was found: the
 * same start time, all user IDs Pogo's, and the turn marker. Bun and Node
 * have no pidfd API, so the check and `kill` run synchronously, without
 * yielding; a PID could change owner only inside that window. Returns the
 * number signalled.
 */
export function signalTurnProcesses(
  table: ProcessTable,
  processes: readonly TurnProcess[],
  turn: string,
  signal: NodeJS.Signals,
) {
  let sent = 0;
  for (const { pid, start } of processes) {
    const now = inspect(table, pid);
    if (
      !now ||
      now.start !== start ||
      !owned(table, now.uids) ||
      !carries(now.environ, turn)
    )
      continue;
    try {
      table.kill(pid, signal);
      sent++;
    } catch {
      // Exited after the check.
    }
  }
  return sent;
}

/**
 * True while the recorded CLI still leads its group: same start time, Pogo's
 * user, the turn marker and the session ID in its arguments. While it lives,
 * its group ID cannot be reused.
 */
function leads(table: ProcessTable, leader: TurnLeader) {
  const now = inspect(table, leader.pid);
  if (
    !now ||
    now.start !== leader.start ||
    now.group !== leader.pid ||
    !owned(table, now.uids) ||
    !carries(now.environ, leader.turn)
  )
    return false;
  try {
    return readFileSync(join(table.root, String(leader.pid), "cmdline"), "utf8")
      .split("\0")
      .some((argument) => argument.includes(leader.session));
  } catch {
    return false;
  }
}

/** Signal a recorded CLI's group only after `leads` holds, synchronously. */
export function signalTurnGroup(
  table: ProcessTable,
  leader: TurnLeader,
  signal: NodeJS.Signals,
) {
  if (!leads(table, leader)) return false;
  try {
    table.kill(-leader.pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function until(
  done: () => boolean | Promise<boolean>,
  ms: number,
  signal?: AbortSignal,
) {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() >= deadline || signal?.aborted) return false;
    await delay(50);
  }
  return true;
}

/** SIGTERM a recorded CLI's group, then SIGKILL it if it still leads. */
async function stopTurnGroup(
  table: ProcessTable,
  leader: TurnLeader,
  grace: number,
  signal?: AbortSignal,
) {
  const gone = () => !leads(table, leader);
  if (!signalTurnGroup(table, leader, "SIGTERM")) return;
  if (await until(gone, grace, signal)) return;
  if (signalTurnGroup(table, leader, "SIGKILL")) await until(gone, grace);
}

/** SIGTERM a turn's processes, then SIGKILL whatever remains after `grace`. */
async function stopTurnProcesses(
  table: ProcessTable,
  turn: string,
  since: number,
  grace: number,
  signal?: AbortSignal,
) {
  const left = () => turnProcesses(table, turn, since);
  const gone = async () => (await left()).length === 0;
  if (!signalTurnProcesses(table, await left(), turn, "SIGTERM")) return;
  if (await until(gone, grace, signal)) return;
  if (signalTurnProcesses(table, await left(), turn, "SIGKILL"))
    await until(gone, grace);
}

/** One spawned Claude Code CLI in its own process group. */
class ClaudeProcess implements SpawnedProcess {
  private signalled = false;
  readonly exited: Promise<void>;

  constructor(
    private readonly child: ChildProcessByStdio<Writable, Readable, null>,
  ) {
    this.exited = new Promise((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
  }

  get stdin() {
    return this.child.stdin;
  }
  get stdout() {
    return this.child.stdout;
  }
  get killed() {
    return this.signalled || this.child.killed;
  }
  get exitCode() {
    return this.child.exitCode;
  }
  get signalCode() {
    return this.child.signalCode;
  }
  get running() {
    return this.child.exitCode === null && this.child.signalCode === null;
  }
  /**
   * Signal the CLI's whole group while the CLI is Pogo's unreaped child: its
   * PID, and so its group ID, cannot be reused before Pogo reaps it.
   */
  kill(signal: NodeJS.Signals) {
    if (!this.running) return false;
    this.signalled = true;
    try {
      if (this.child.pid === undefined) return false;
      process.kill(-this.child.pid, signal);
      return true;
    } catch {
      return this.child.kill(signal);
    }
  }

  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(
    event: "exit" | "error",
    listener:
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void),
  ) {
    this.child.on(event, listener);
  }

  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  once(event: "error", listener: (error: Error) => void): void;
  once(
    event: "exit" | "error",
    listener:
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void),
  ) {
    this.child.once(event, listener);
  }

  off(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  off(event: "error", listener: (error: Error) => void): void;
  off(
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
const recordSchema = z.strictObject({
  pid: z.number().int().positive(),
  turn: z.uuid(),
  since: z.number().int().nonnegative(),
});

/**
 * Test seams: a fake CLI path (production uses the SDK's native binary) and
 * the SIGTERM-to-SIGKILL grace period.
 */
export type ClaudeRuntime = { executable?: string; graceMs?: number };

export class ClaudeBackend implements AgentBackend {
  readonly supportsAttachments = true;
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

  static async open(
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

  async createSession({
    title,
    signal,
  }: Parameters<AgentBackend["createSession"]>[0]) {
    signal.throwIfAborted();
    if (this.closed) throw new Error("Claude backend is closing");
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    for (const directory of directories) {
      try {
        await access(join(projects, directory, `${id}.jsonl`));
        return true;
      } catch {}
    }
    return false;
  }

  async prompt(
    sessionId: string,
    text: string,
    signal: AbortSignal,
    onText?: TextSink,
    onInput?: (id: string) => void,
    files: readonly Attachment[] = [],
    context?: PromptSourceContext,
  ): Promise<string> {
    signal.throwIfAborted();
    if (this.closed) throw new Error("Claude backend is closing");
    const parsed = sessionIDSchema.safeParse(sessionId);
    if (!parsed.success)
      throw new ClaudeTurnError("Claude session ID is not valid");
    const id = parsed.data;
    if (this.runs.has(id)) throw new ClaudeTurnError("Claude session is busy");
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
      // A private temporary directory per turn, removed after the CLI exits.
      temporary = await mkdtemp(join(tmpdir(), "pogo-claude-"));
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
      async function* messages() {
        yield message;
        // Closing input after the result lets the CLI exit cleanly.
        await answered.promise;
      }
      const options: Options = {
        abortController: run.controller,
        cwd: this.config.directory,
        model: this.config.model,
        env,
        // The same bare names select the visible tools and permit them.
        tools: [...this.config.allowedTools],
        allowedTools: [...this.config.allowedTools],
        permissionMode: "dontAsk",
        permissionPrompts: "none",
        settingSources: this.config.settingSources,
        // Loaded settings cannot run hooks or change the routing variables.
        settings: { env: claudeRouting(this.config), disableAllHooks: true },
        mcpServers: {},
        strictMcpConfig: true,
        // Slack text is data: no @file expansion or slash-command dispatch.
        verbatimPrompts: true,
        includePartialMessages: onText !== undefined,
        maxTurns: this.config.maxTurns,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          ...(this.config.systemPrompt
            ? { append: this.config.systemPrompt }
            : {}),
        },
        ...(this.config.effort ? { effort: this.config.effort } : {}),
        ...(resume
          ? { resume: id }
          : { sessionId: id, ...(title ? { title } : {}) }),
        ...(this.runtime.executable
          ? { pathToClaudeCodeExecutable: this.runtime.executable }
          : {}),
        spawnClaudeCodeProcess: (spawn) => this.spawn(run, spawn),
      };
      const turn = new ClaudeTurn();
      let settle: ReturnType<typeof setTimeout> | undefined;
      try {
        for await (const frame of query({ prompt: messages(), options })) {
          const changed = turn.add(frame);
          if (turn.session !== undefined && turn.session !== id)
            throw new ClaudeTurnError("Claude session identity changed");
          if (changed && onText) {
            const visible = turn.visible();
            if (visible) onText(visible);
          }
          if (turn.result && !settle) {
            answered.resolve();
            // Background work can keep the CLI alive; it ends with the turn.
            settle = setTimeout(stop, this.grace);
          }
        }
      } catch (error) {
        // The result completes the turn; a later teardown error does not.
        if (!turn.result || signal.aborted) throw error;
      } finally {
        clearTimeout(settle);
        answered.resolve();
      }
      signal.throwIfAborted();
      if (!turn.result)
        throw new ClaudeTurnError("Claude turn ended without a result");
      if (!turn.result.ok)
        throw new ClaudeTurnError(`Claude turn failed: ${turn.result.cause}`);
      return turn.answer();
    } catch (error) {
      // A failed turn must not leave its CLI running.
      stop();
      signal.throwIfAborted();
      if (
        error instanceof AttachmentInputUnavailable ||
        error instanceof ClaudeTurnError
      )
        throw error;
      // SDK errors can carry CLI output or request details; never forward them.
      throw new ClaudeTurnError("Claude turn failed");
    } finally {
      signal.removeEventListener("abort", stop);
      await this.finish(run);
      if (temporary)
        await rm(temporary, { recursive: true, force: true }).catch(() => {});
      if (this.runs.get(id) === run) this.runs.delete(id);
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
    if (run.controller.signal.aborted) cli.kill("SIGTERM");
    return cli;
  }

  /**
   * Wait for the CLI to exit, stopping its group when it does not, then stop
   * every verified process of the turn that is still left.
   */
  private async finish(run: Run) {
    const cli = run.process;
    if (!cli) return;
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
    await stopTurnProcesses(systemProcesses, run.turn, run.since, this.grace);
    await rm(run.record, { force: true });
  }

  /**
   * Stop what a turn of an earlier Pogo process left running. Its group is
   * signalled only while the recorded CLI verifiably leads it; other
   * processes only while their start time, user and marker match. Linux
   * only; elsewhere nothing is signalled.
   */
  private async stopOrphan(id: string, signal: AbortSignal) {
    if (this.runs.get(id)?.process) return;
    const path = join(this.records, `${id}.json`);
    let record: z.infer<typeof recordSchema>;
    try {
      record = recordSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch {
      return;
    }
    const leader = {
      pid: record.pid,
      start: record.since,
      turn: record.turn,
      session: id,
    };
    await stopTurnGroup(systemProcesses, leader, this.grace, signal);
    await stopTurnProcesses(
      systemProcesses,
      record.turn,
      record.since,
      this.grace,
      signal,
    );
    await rm(path, { force: true });
  }

  async interrupt(sessionId: string, signal: AbortSignal) {
    const id = sessionIDSchema.safeParse(sessionId);
    if (!id.success) return;
    const run = this.runs.get(id.data);
    if (run) {
      run.controller.abort();
      run.process?.kill("SIGTERM");
      await run.done;
      return;
    }
    await this.stopOrphan(id.data, signal);
  }

  async close() {
    this.closed = true;
    const runs = [...this.runs.values()];
    for (const run of runs) {
      run.controller.abort();
      run.process?.kill("SIGTERM");
    }
    await Promise.all(runs.map((run) => run.done));
  }
}
