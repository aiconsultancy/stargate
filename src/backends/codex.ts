import { constants, existsSync, writeFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  Codex,
  type CodexOptions,
  type ThreadOptions,
  type UserInput,
} from "@openai/codex-sdk";
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
import {
  AttachmentInputUnavailable,
  BackendFailure,
  type BackendFailureKind,
  statusKind,
} from "../request-failure";
import {
  bootTicks,
  inherited,
  isTextAttachment,
  stopTurnProcesses,
  systemProcesses,
  type TurnMarker,
  textAttachment,
} from "./cli-agent";
import {
  checkCodexPaths,
  codexSearchPath,
  linkFree,
  nativeCodex,
  trustedPath,
  trustedUtilities,
  writableRoots,
} from "./codex-paths";

export { nativeCodex } from "./codex-paths";

type Config = Extract<BackendConfig, { type: "codex" }>;
type CodexConfig = NonNullable<CodexOptions["config"]>;

/** Fixed, safe failure text produced by this adapter. */
class CodexTurnError extends Error {}

// A CLI that ends without a result proves nothing about its tools: frames
// can be lost with the process. Never report that nothing ran.
const crashed = { ran: true } as const;

/** Conversation and thread IDs are UUIDs: never options, paths or flags. */
const idSchema = z.uuid();
/** The turn marker variable of Codex children; see `TurnMarker`. */
const turnVariable = "STARGATE_CODEX_TURN";
/** The proxy key's variable in the Codex process; tool commands never get it. */
const keyVariable = "STARGATE_CODEX_PROVIDER_KEY";

/** Private directories of one backend namespace under its data directory. */
export function codexDirectories(data: string) {
  return {
    /** `CODEX_HOME`: threads, state and caches. */
    home: join(data, "codex"),
    /** Stargate conversation → Codex thread. */
    threads: join(data, "codex-threads"),
    /** Records of running turns, for restart recovery. */
    records: join(data, "codex-runs"),
    /** An empty `ZDOTDIR`: zsh tool commands never read `~/.zshenv`. */
    shell: join(data, "codex-shell"),
    /** Stargate's per-turn launchers; see `codexLauncher`. */
    bin: join(data, "codex-bin"),
  };
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Stargate's `codexPathOverride`. The SDK exposes neither the CLI process nor
 * its output stream, and a process that the CLI starts can inherit that
 * output and keep it open. The launcher `exec`s the CLI, which stays the
 * SDK's child (its signals and exit status are unchanged), but sends the
 * CLI's output through an unlinked FIFO to `cat`. Only `cat` then holds
 * Stargate's stdout and stderr, and it carries the turn marker, so the turn
 * clean-up always closes them. The CLI's stderr is discarded; Stargate never
 * uses it.
 *
 * The launcher runs before the sandbox with the key in its environment, so
 * every command is an absolute path: `utilities` from `trustedUtilities`
 * and the native CLI. Nothing is looked up through `PATH`.
 */
export function codexLauncher(
  cli: string,
  utilities: Record<"sh" | "mkfifo" | "cat" | "rm", string>,
) {
  const tool = (name: keyof typeof utilities) => shellQuote(utilities[name]);
  if (!/^\/[A-Za-z0-9._+/-]+$/.test(utilities.sh))
    throw new Error("Codex launcher shell path is not usable");
  return [
    `#!${utilities.sh}`,
    "set -eu",
    // The turn's private TMPDIR; `set -u` fails when it is unset.
    'out="$TMPDIR/stargate-codex-output"',
    `${tool("mkfifo")} -m 600 "$out"`,
    `${tool("cat")} "$out" &`,
    // Returns once cat has opened the FIFO. Removing its path then keeps
    // every other process out.
    'exec 3>"$out"',
    `${tool("rm")} -f "$out"`,
    `exec ${shellQuote(cli)} "$@" >&3 3>&- 2>/dev/null`,
    "",
  ].join("\n");
}

/**
 * Fails closed unless `path` is the launcher just written: a regular file
 * of Stargate's user with mode 0700 and exactly the `expected` content, in a
 * directory of Stargate's user with mode 0700, with no symbolic link anywhere on
 * its path. Run immediately before a turn.
 */
export async function verifyLauncher(path: string, expected: string) {
  const uid = process.getuid?.();
  const directory = await lstat(dirname(path));
  const file = await lstat(path);
  if (
    !(await linkFree(path)) ||
    !directory.isDirectory() ||
    directory.uid !== uid ||
    (directory.mode & 0o777) !== 0o700 ||
    !file.isFile() ||
    file.uid !== uid ||
    (file.mode & 0o777) !== 0o700 ||
    (await readFile(path, "utf8")) !== expected
  )
    throw new CodexTurnError("Codex launcher failed verification");
}

/**
 * Creates the launcher at its canonical `path` and verifies it: no symbolic
 * link on the way, no existing file, and never through a link
 * (`O_EXCL | O_NOFOLLOW`).
 */
export async function writeLauncher(path: string, script: string) {
  if (!(await linkFree(dirname(path))))
    throw new CodexTurnError("Codex launcher failed verification");
  const file = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o700,
  );
  try {
    await file.writeFile(script);
  } finally {
    await file.close();
  }
  await verifyLauncher(path, script);
}

/**
 * The CLI's environment: the shared non-secret allowlist, a private
 * `CODEX_HOME` for this namespace (so `~/.codex`, its login and its config
 * are never used) and the proxy key under a Stargate variable. The SDK passes
 * nothing else from Stargate's environment.
 */
export function codexEnvironment(
  config: Config,
  data: string,
  parent: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const directories = codexDirectories(data);
  return {
    ...inherited(parent),
    CODEX_HOME: directories.home,
    // Codex runs commands with the account's login shell, whatever SHELL
    // says. zsh reads `$ZDOTDIR/.zshenv` even when not interactive.
    ZDOTDIR: directories.shell,
    // Direct connections only; no inherited HTTP proxy.
    NO_PROXY: "*",
    [keyVariable]: secret(config.provider.apiKeyEnv, parent),
  };
}

/**
 * `--config` overrides. Command-line overrides are Codex's highest layer
 * below managed policy, so `CODEX_HOME` or project configuration cannot
 * redirect the endpoint or key. The rest turns off what loads instructions
 * or code from outside Stargate's configuration (skills, AGENTS.md, plugins,
 * shell start-up files), subagents, and optional network traffic.
 */
export function codexConfig(config: Config): CodexConfig {
  return {
    model_provider: "stargate",
    model_providers: {
      stargate: {
        name: "Stargate proxy",
        base_url: config.provider.baseURL,
        env_key: keyVariable,
        wire_api: "responses",
        requires_openai_auth: false,
      },
    },
    ...(config.projectDocs ? {} : { project_doc_max_bytes: 0 }),
    ...(config.systemPrompt
      ? { developer_instructions: config.systemPrompt }
      : {}),
    skills: { include_instructions: false },
    agents: { enabled: false },
    features: {
      // Code and instructions from outside Stargate's configuration.
      plugins: false,
      remote_plugin: false,
      apps: false,
      hooks: false,
      memories: false,
      // Login shell start-up files.
      shell_snapshot: false,
      // Tools with no use in a gateway turn.
      goals: false,
      tool_suggest: false,
      image_generation: false,
      multi_agent: false,
    },
    analytics: { enabled: false },
    feedback: { enabled: false },
    check_for_update_on_startup: false,
    allow_login_shell: false,
    history: { persistence: "none" },
    shell_environment_policy: { exclude: [keyVariable] },
    // workspace-write: `directory` and the turn's TMPDIR, not shared /tmp.
    sandbox_workspace_write: { exclude_slash_tmp: true },
  };
}

/** Thread options: sandbox, approval and network are always explicit. */
export function codexThreadOptions(config: Config): ThreadOptions {
  return {
    model: config.model,
    sandboxMode: config.sandbox,
    // Never ask: a request to leave the sandbox is refused, not approved.
    approvalPolicy: "never",
    workingDirectory: config.directory,
    skipGitRepoCheck: true,
    networkAccessEnabled: config.network,
    webSearchMode: "disabled",
    ...(config.reasoningEffort
      ? { modelReasoningEffort: config.reasoningEffort }
      : {}),
  };
}

const imageTypes: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/** Prompt text with UTF-8 text files inline, and the images to attach. */
export function codexInput(
  text: string,
  files: readonly Attachment[],
): { text: string; images: Attachment[] } {
  try {
    checkAttachments(files);
  } catch {
    throw new AttachmentInputUnavailable(
      "Invalid or oversized Codex attachments",
    );
  }
  const parts = text ? [text] : [];
  const images: Attachment[] = [];
  for (const file of files) {
    if (imageTypes[file.mime]) {
      parts.push(`Attachment: ${file.name} (image ${images.length + 1})`);
      images.push(file);
    } else if (isTextAttachment(file)) parts.push(textAttachment(file));
    else
      throw new AttachmentInputUnavailable(
        "Codex supports UTF-8 text and PNG/JPEG/GIF/WebP attachments only",
      );
  }
  return { text: parts.join("\n\n"), images };
}

const startedEvent = z.object({
  type: z.literal("thread.started"),
  thread_id: z.string(),
});
const itemEvent = z.object({
  type: z.enum(["item.started", "item.updated", "item.completed"]),
  item: z.object({
    id: z.string(),
    type: z.string(),
    text: z.string().optional(),
  }),
});
const endEvent = z.object({
  type: z.enum(["turn.completed", "turn.failed", "error"]),
  // `error` carries `message`; `turn.failed` carries `error.message`.
  message: z.string().optional(),
  error: z.object({ message: z.string() }).optional(),
});
/** Items that mean the turn did work outside the model. */
const workItems = new Set([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
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
  if (status)
    return { kind: statusKind(Number(status)), status: Number(status) };
  if (/usage limit|rate limit|quota|too many requests/i.test(message))
    return { kind: "quota" };
  if (/unauthorized|api key|authentication|access token/i.test(message))
    return { kind: "auth" };
  if (/timed out|timeout/i.test(message)) return { kind: "timeout" };
  if (
    /error sending request|connection (?:refused|reset|closed)|stream disconnected|dns error|network/i.test(
      message,
    )
  )
    return { kind: "network" };
  return undefined;
}

/**
 * Visible text of one turn: agent messages only, never reasoning, commands,
 * tool output or error items. Failure text is never kept.
 */
export class CodexTurn {
  private readonly messages = new Map<string, string>();
  thread: string | undefined;
  result: { ok: boolean } | undefined;
  /** A command, file change or tool call was seen. */
  worked = false;
  /** What the failure event named, without its text. */
  failure: ReturnType<typeof codexFailureKind>;

  /** Returns true when the visible text may have changed. */
  add(raw: unknown): boolean {
    const started = startedEvent.safeParse(raw);
    if (started.success) {
      this.thread = started.data.thread_id;
      return false;
    }
    const item = itemEvent.safeParse(raw);
    if (item.success) {
      const { id, type, text } = item.data.item;
      if (workItems.has(type)) this.worked = true;
      if (type !== "agent_message" || text === undefined) return false;
      if (this.messages.get(id) === text) return false;
      this.messages.set(id, text);
      return true;
    }
    const end = endEvent.safeParse(raw);
    if (end.success) {
      this.result = { ok: end.data.type === "turn.completed" };
      const message = end.data.error?.message ?? end.data.message;
      if (!this.result.ok && message)
        this.failure = codexFailureKind(message) ?? this.failure;
    }
    return false;
  }

  answer(): string {
    return [...this.messages.values()].filter(Boolean).join("\n\n");
  }
}

type Run = {
  /** Aborted to cancel the turn; never handed to the SDK itself. */
  controller: AbortController;
  done: Promise<void>;
  marker: TurnMarker;
  /** Turn start in clock ticks; no process of the turn is older. */
  since: number;
  record: string;
};

/** A turn in progress, kept on disk so a later process can stop it. */
const recordSchema = z.strictObject({
  turn: z.uuid(),
  since: z.number().int().nonnegative(),
});
const threadSchema = z.strictObject({ thread: z.uuid() });

/**
 * Test seams: a fake CLI for the launcher to start (production uses the
 * SDK's bundled binary), the SIGTERM-to-SIGKILL grace period, extra child
 * variables, and the system directories for `PATH`.
 */
export type CodexRuntime = {
  executable?: string;
  graceMs?: number;
  environment?: Record<string, string>;
  /** Replaces the system directories of `codexSearchPath`. */
  searchDirectories?: readonly string[];
};

export class CodexBackend implements AgentBackend {
  readonly supportsAttachments = true;
  private readonly runs = new Map<string, Run>();
  private closed = false;

  private readonly threads: string;
  private readonly records: string;

  private constructor(
    private readonly config: Config,
    /** This namespace's data directory; see `codexDirectories`. */
    private readonly data: string,
    private readonly runtime: CodexRuntime,
    /** The CLI that each turn's launcher `exec`s. */
    private readonly cli: string,
    private readonly utilities: Awaited<ReturnType<typeof trustedUtilities>>,
    /** The CLI's fixed `PATH`; see `codexSearchPath`. */
    private readonly searchPath: string,
  ) {
    ({ threads: this.threads, records: this.records } = codexDirectories(data));
  }

  private get grace() {
    return this.runtime.graceMs ?? 5000;
  }

  static async open(
    config: Config,
    context: BackendContext,
    runtime: CodexRuntime = {},
  ) {
    // Fail at startup, not on the first turn, when the key is missing.
    secret(config.provider.apiKeyEnv);
    // From here on Stargate uses only the canonical form of each path that it
    // writes, checks or runs, and refuses links that could change later.
    const write = config.sandbox === "workspace-write";
    const directory = write
      ? await trustedPath(config.directory)
      : config.directory;
    const roots = write ? [directory] : [];
    const data = await trustedPath(context.dataDirectory, roots);
    const canonical = { ...config, directory };
    // Nothing that runs outside the sandbox may be writable from inside it.
    await checkCodexPaths(canonical, data);
    const utilities = await trustedUtilities();
    const directories = codexDirectories(data);
    for (const path of Object.values(directories)) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      if (!(await linkFree(path)))
        throw new Error("Codex data directories must not be symbolic links");
      await chmod(path, 0o700);
    }
    // Launchers are written per turn; none from earlier runs is kept.
    await rm(directories.bin, { recursive: true, force: true });
    await mkdir(directories.bin, { mode: 0o700 });
    await chmod(directories.bin, 0o700);
    const native = nativeCodex();
    const helpers = existsSync(native.helpers)
      ? await trustedPath(native.helpers, roots)
      : undefined;
    return new CodexBackend(
      canonical,
      data,
      runtime,
      await trustedPath(runtime.executable ?? native.executable, roots),
      utilities,
      await codexSearchPath(
        config.extraPath,
        helpers,
        roots,
        runtime.searchDirectories,
      ),
    );
  }

  async createSession({
    signal,
  }: Parameters<AgentBackend["createSession"]>[0]) {
    signal.throwIfAborted();
    if (this.closed) throw new Error("Codex backend is closing");
    // Codex assigns the thread ID on the first turn; Stargate maps to it.
    return crypto.randomUUID();
  }

  /** The Codex thread of a conversation in this namespace, if it started. */
  private async thread(id: string) {
    try {
      return threadSchema.parse(
        JSON.parse(await readFile(join(this.threads, `${id}.json`), "utf8")),
      ).thread;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new CodexTurnError("Codex thread mapping is unreadable");
    }
  }

  async prompt(
    sessionId: string,
    text: string,
    signal: AbortSignal,
    onText?: TextSink,
    _onInput?: (id: string) => void,
    files: readonly Attachment[] = [],
    context?: PromptSourceContext,
  ): Promise<string> {
    signal.throwIfAborted();
    if (this.closed) throw new Error("Codex backend is closing");
    const parsed = idSchema.safeParse(sessionId);
    if (!parsed.success)
      throw new CodexTurnError("Codex conversation ID is not valid");
    const id = parsed.data;
    if (this.runs.has(id)) throw new CodexTurnError("Codex thread is busy");
    const input = codexInput(
      context ? `${sourceLine(context)}\n\n${text}` : text,
      files,
    );
    const env = codexEnvironment(this.config, this.data);
    const run: Run = {
      controller: new AbortController(),
      done: Promise.resolve(),
      marker: { variable: turnVariable, value: crypto.randomUUID() },
      since: 0,
      record: join(this.records, `${id}.json`),
    };
    this.runs.set(id, run);
    const finished = Promise.withResolvers<void>();
    run.done = finished.promise;
    const stop = () => run.controller.abort();
    signal.addEventListener("abort", stop, { once: true });
    /**
     * The SDK's signal, aborted only while its event stream is open. Once
     * the stream ends early, the SDK has dropped the child's error listener
     * but not the child's abort listener, so a later abort would raise an
     * unhandled error. Leftover processes are stopped by marker instead.
     */
    const sdk = new AbortController();
    let live = false;
    let temporary: string | undefined;
    let launcher: string | undefined;
    let recorded = false;
    /**
     * The SDK only sends SIGTERM and then waits for the CLI's output to
     * end, which a CLI that ignores SIGTERM never does. Cancellation
     * therefore also starts the bounded clean-up of every marked process,
     * the CLI included, without waiting for the stream. If the stream has
     * still not ended shortly after that, the turn stops waiting for it.
     */
    let reaping: Promise<void> | undefined;
    const abandon = Promise.withResolvers<"abandon">();
    const cancel = () => {
      if (live) sdk.abort();
      if (!recorded || reaping !== undefined) return;
      reaping = stopTurnProcesses(
        systemProcesses,
        run.marker,
        run.since,
        this.grace,
      ).catch(() => {});
      void reaping
        .then(() =>
          delay(Math.min(this.grace, 1000), undefined, { ref: false }),
        )
        .then(() => abandon.resolve("abandon"));
    };
    run.controller.signal.addEventListener("abort", cancel, { once: true });
    try {
      // Never resume a thread that an earlier process is still running.
      await this.stopOrphan(id, AbortSignal.timeout(5000));
      temporary = await mkdtemp(join(tmpdir(), "stargate-codex-"));
      const roots = writableRoots(this.config);
      // Again for each turn, on canonical paths only.
      try {
        temporary = await trustedPath(temporary, roots);
        await checkCodexPaths(this.config, this.data, temporary);
        for (const path of Object.values(codexDirectories(this.data)))
          if (!(await linkFree(path)))
            throw new Error(
              "Codex data directories must not be symbolic links",
            );
      } catch (error) {
        throw new CodexTurnError((error as Error).message);
      }
      const prompt: UserInput[] = [{ type: "text", text: input.text }];
      for (const [index, image] of input.images.entries()) {
        const path = join(
          temporary,
          `attachment-${index + 1}${imageTypes[image.mime]}`,
        );
        await writeFile(path, image.data, { mode: 0o600 });
        prompt.push({ type: "local_image", path });
      }
      const mapped = await this.thread(id);
      run.since = await bootTicks();
      writeFileSync(
        run.record,
        JSON.stringify({ turn: run.marker.value, since: run.since }),
        { mode: 0o600 },
      );
      recorded = true;
      signal.throwIfAborted();
      run.controller.signal.throwIfAborted();
      // A new launcher for each turn, checked immediately before it runs.
      launcher = join(
        codexDirectories(this.data).bin,
        `${run.marker.value}.sh`,
      );
      await writeLauncher(launcher, codexLauncher(this.cli, this.utilities));
      const codex = new Codex({
        env: {
          ...env,
          PATH: this.searchPath,
          // A private temporary directory per turn, removed afterwards.
          TMPDIR: temporary,
          [turnVariable]: run.marker.value,
          ...this.runtime.environment,
        },
        config: codexConfig(this.config),
        codexPathOverride: launcher,
      });
      const options = codexThreadOptions(this.config);
      const thread = mapped
        ? codex.resumeThread(mapped, options)
        : codex.startThread(options);
      const turn = new CodexTurn();
      let known = mapped;
      let settle: ReturnType<typeof setTimeout> | undefined;
      live = true;
      const { events } = await thread.runStreamed(prompt, {
        signal: sdk.signal,
      });
      const stream = events[Symbol.asyncIterator]();
      let open = true;
      try {
        for (;;) {
          const next = stream.next();
          const step = await Promise.race([next, abandon.promise]);
          if (step === "abandon") {
            // Clean-up ran and the stream still did not end: stop waiting.
            next.catch(() => {});
            break;
          }
          if (step.done) {
            open = false;
            break;
          }
          const event = step.value;
          // Leaving the loop closes the stream: no SDK abort after that.
          live = false;
          const changed = turn.add(event);
          if (turn.thread !== undefined && turn.thread !== known) {
            if (known !== undefined || !idSchema.safeParse(turn.thread).success)
              throw new CodexTurnError("Codex thread identity changed");
            // Synchronous: the mapping exists before the turn continues.
            writeFileSync(
              join(this.threads, `${id}.json`),
              JSON.stringify({ thread: turn.thread }),
              { mode: 0o600 },
            );
            known = turn.thread;
          }
          if (changed && onText) {
            const visible = turn.answer();
            if (visible) onText(visible);
          }
          if (turn.result && !settle)
            // A CLI that does not exit after its result is stopped.
            settle = setTimeout(stop, this.grace);
          live = true;
          if (run.controller.signal.aborted) sdk.abort();
        }
      } catch (error) {
        // The result completes the turn; a later teardown error does not.
        if (signal.aborted || error instanceof CodexTurnError) throw error;
        // The CLI ended without a result; SDK errors carry its stderr.
        if (!turn.result) throw new BackendFailure("crash", crashed);
      } finally {
        live = false;
        clearTimeout(settle);
        // Closes the SDK's stream, now or once a pending read settles.
        if (open) stream.return(undefined).catch(() => {});
      }
      signal.throwIfAborted();
      if (!turn.result) throw new BackendFailure("crash", crashed);
      if (!turn.result.ok)
        throw turn.failure
          ? new BackendFailure(turn.failure.kind, {
              status: turn.failure.status,
              ran: turn.worked,
            })
          : new CodexTurnError("Codex turn failed");
      return turn.answer();
    } catch (error) {
      // The SDK SIGTERMs its CLI when the stream closes early; the marker
      // clean-up below stops whatever remains.
      signal.throwIfAborted();
      if (
        error instanceof AttachmentInputUnavailable ||
        error instanceof BackendFailure ||
        error instanceof CodexTurnError
      )
        throw error;
      // SDK errors carry the CLI's stderr; never forward them.
      throw new CodexTurnError("Codex turn failed");
    } finally {
      signal.removeEventListener("abort", stop);
      run.controller.signal.removeEventListener("abort", cancel);
      await reaping;
      // Stop every verified process of the turn that is still left.
      if (recorded)
        await stopTurnProcesses(
          systemProcesses,
          run.marker,
          run.since,
          this.grace,
        );
      if (temporary)
        await rm(temporary, { recursive: true, force: true }).catch(() => {});
      if (launcher) await rm(launcher, { force: true }).catch(() => {});
      if (recorded) await rm(run.record, { force: true });
      if (this.runs.get(id) === run) this.runs.delete(id);
      finished.resolve();
    }
  }

  /**
   * Stop what a turn of an earlier Stargate process left running: processes of
   * Stargate's user that carry its marker and started after it began, each
   * checked again immediately before its signal. Linux only.
   */
  private async stopOrphan(id: string, signal: AbortSignal) {
    const path = join(this.records, `${id}.json`);
    let record: z.infer<typeof recordSchema>;
    try {
      record = recordSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch {
      return;
    }
    await stopTurnProcesses(
      systemProcesses,
      { variable: turnVariable, value: record.turn },
      record.since,
      this.grace,
      signal,
    );
    await rm(path, { force: true });
  }

  async interrupt(sessionId: string, signal: AbortSignal) {
    const id = idSchema.safeParse(sessionId);
    if (!id.success) return;
    const run = this.runs.get(id.data);
    if (run) {
      run.controller.abort();
      await run.done;
      return;
    }
    await this.stopOrphan(id.data, signal);
  }

  async close() {
    this.closed = true;
    const runs = [...this.runs.values()];
    for (const run of runs) run.controller.abort();
    await Promise.all(runs.map((run) => run.done));
  }
}
