import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Option, Schema } from "effect";
import {
  type Attachment,
  checkAttachments,
} from "../chat/attachments/attachments";
import { secret } from "../lib/credentials";
import {
  AttachmentInputUnavailable,
  BackendFailure,
} from "../shared/request-failure";
import type { TurnStage } from "../shared/turn-progress";
import {
  type ActivityRequest,
  type AgentBackend,
  type BackendContext,
  type TurnActivityLog,
  type TurnActivityRecorder,
  sourceLine,
} from "./backend";
import {
  type TurnMarker,
  bootTicks,
  inherited,
  isTextAttachment,
  stopTurnProcesses,
  systemProcesses,
  textAttachment,
} from "./cli-agent";
import {
  checkCodexPaths,
  codexSearchPath,
  linkFree,
  nativeCodex,
  trustedPath,
  writableRoots,
} from "./codex-paths";
import {
  CodexAppServerClient,
  CodexAppServerRpcError,
  type CodexAppServerUserInput,
  type CodexConfigObject,
  CodexTurn,
  codexAppServerArgs,
  codexFailureKind,
  codexSandboxPolicy,
  decodeThreadResponse,
  decodeTurnResponse,
  notificationIds,
} from "./codex/app-server";
import type { codexBackendSchema } from "./codex/config";

export { nativeCodex } from "./codex-paths";

export { CodexTurn, codexFailureKind } from "./codex/app-server";

type Config = typeof codexBackendSchema.Type;

/** Fixed, safe failure text produced by this adapter. */
class CodexTurnError extends Error {}

// A CLI that ends without a result proves nothing about its tools: frames
// Can be lost with the process. Never report that nothing ran.
const crashed = { ran: true } as const;

/** Bounded wait for `turn/interrupt` before forcing SIGTERM on cancel. */
const INTERRUPT_GRACE_MS = 100;

/** Conversation and thread IDs are UUIDs: never options, paths or flags. */
const maximumID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

const idSchema = Schema.String.check(
  Schema.isUUID(),
  // Preserve existing ID spelling.
  Schema.makeFilter((id) => id.toLowerCase() !== maximumID || id === maximumID),
);

const isID = Schema.is(idSchema);

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
  };
}

/**
 * The CLI's environment: the shared non-secret allowlist, a private
 * `CODEX_HOME` for this namespace (so `~/.codex`, its login and its config
 * are never used) and the proxy key under a Stargate variable.
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
    // Says. zsh reads `$ZDOTDIR/.zshenv` even when not interactive.
    ZDOTDIR: directories.shell,
    // Direct connections only; no inherited HTTP proxy.
    NO_PROXY: "*",
    [keyVariable]: secret(config.provider.apiKeyEnv, parent),
  };
}

/**
 * `--config` overrides passed to `codex app-server`. Command-line overrides
 * sit above `CODEX_HOME` and project configuration, so nothing can redirect
 * the endpoint or key, and project `.codex/config.toml` stays untrusted even
 * under `workspace-write`.
 */
export function codexConfig(config: Config): CodexConfigObject {
  const overrides: Record<string, CodexConfigObject[string]> = {
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
    web_search: "disabled",
    skills: { include_instructions: false },
    agents: { enabled: false },
    features: {
      plugins: false,
      remote_plugin: false,
      apps: false,
      hooks: false,
      memories: false,
      shell_snapshot: false,
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
    shell_environment_policy: {
      exclude: [keyVariable],
      // Network seccomp makes getpeername fail with EPERM, which Bash
      // Mistakes for a remote shell at level 1 and sources HOME/.bashrc.
      set: { SHLVL: "1" },
    },
    // Workspace-write: `directory` and the turn's TMPDIR, not shared /tmp.
    sandbox_workspace_write: { exclude_slash_tmp: true },
  };

  if (config.sandbox !== "read-only") {
    overrides["projects"] = {
      [config.directory]: { trust_level: "untrusted" },
    };
  }

  if (!config.projectDocs) {
    overrides["project_doc_max_bytes"] = 0;
  }

  if (config.systemPrompt) {
    overrides["developer_instructions"] = config.systemPrompt;
  }

  return overrides;
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
    } else if (isTextAttachment(file)) {
      parts.push(textAttachment(file));
    } else {
      throw new AttachmentInputUnavailable(
        "Codex supports UTF-8 text and PNG/JPEG/GIF/WebP attachments only",
      );
    }
  }

  return { text: parts.join("\n\n"), images };
}

type Run = {
  controller: AbortController;
  done: Promise<void>;
  marker: TurnMarker;
  since: number;
  record: string;
  client?: CodexAppServerClient;
  threadId?: string;
  turnId?: string;
  settled: boolean;
};

/** A turn in progress, kept on disk so a later process can stop it. */
const recordSchema = Schema.Struct({
  turn: idSchema,
  since: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const threadSchema = Schema.Struct({ thread: idSchema });

const decodeRecord = Schema.decodeUnknownSync(recordSchema, {
  onExcessProperty: "error",
});

const decodeThread = Schema.decodeUnknownSync(threadSchema, {
  onExcessProperty: "error",
});

/**
 * Test seams: a fake CLI executable (production uses the pinned `@openai/codex`
 * binary), SIGTERM-to-SIGKILL grace period, extra child variables, and system
 * directories for `PATH`.
 */
export type CodexRuntime = {
  executable?: string;
  graceMs?: number;
  environment?: Record<string, string>;
  searchDirectories?: readonly string[];
};

export class CodexBackend implements AgentBackend {
  public readonly supportsAttachments = true;
  private readonly runs = new Map<string, Run>();
  private closed = false;

  private readonly threads: string;
  private readonly records: string;

  private constructor(
    private readonly config: Config,
    private readonly data: string,
    private readonly runtime: CodexRuntime,
    private readonly cli: string,
    private readonly searchPath: string,
    private readonly activity?: TurnActivityRecorder,
  ) {
    ({ threads: this.threads, records: this.records } = codexDirectories(data));
  }

  private get grace() {
    return this.runtime.graceMs ?? 5000;
  }

  public static async open(
    config: Config,
    context: BackendContext,
    runtime: CodexRuntime = {},
  ) {
    // Fail at startup, not on the first turn, when the key is missing.
    secret(config.provider.apiKeyEnv);
    const write = config.sandbox === "workspace-write";

    const directory = write
      ? await trustedPath(config.directory)
      : config.directory;

    const roots = write ? [directory] : [];
    const data = await trustedPath(context.dataDirectory, roots);
    const canonical = { ...config, directory };
    // Nothing that runs outside the sandbox may be writable from inside it.
    await checkCodexPaths(canonical, data);
    const directories = codexDirectories(data);

    for (const path of Object.values(directories)) {
      await mkdir(path, { recursive: true, mode: 0o700 });

      if (!(await linkFree(path))) {
        throw new Error("Codex data directories must not be symbolic links");
      }

      await chmod(path, 0o700);
    }

    const native = nativeCodex();

    const helpers = existsSync(native.helpers)
      ? await trustedPath(native.helpers, roots)
      : undefined;

    return new CodexBackend(
      canonical,
      data,
      runtime,
      await trustedPath(runtime.executable ?? native.executable, roots),
      await codexSearchPath(
        config.extraPath,
        helpers,
        roots,
        runtime.searchDirectories,
      ),
      context.activity,
    );
  }

  public createSession({
    signal,
  }: Parameters<AgentBackend["createSession"]>[0]) {
    signal.throwIfAborted();

    if (this.closed) {
      return Promise.reject(new CodexTurnError("Codex backend is closing"));
    }

    return Promise.resolve(crypto.randomUUID());
  }

  private async thread(id: string) {
    try {
      return decodeThread(
        JSON.parse(await readFile(join(this.threads, `${id}.json`), "utf8")),
      ).thread;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }

      throw new CodexTurnError("Codex thread mapping is unreadable");
    }
  }

  private beginActivity(
    sessionId: string,
    activityRequests?: () => readonly ActivityRequest[],
  ): TurnActivityLog | undefined {
    if (!this.activity) {
      return undefined;
    }

    let links: readonly ActivityRequest[] | undefined;

    try {
      links = activityRequests?.();
    } catch {
      // Best-effort links.
    }

    try {
      return this.activity.begin(links, sessionId);
    } catch {
      return undefined;
    }
  }

  private async openThread(
    client: CodexAppServerClient,
    mapped: string | undefined,
  ): Promise<string> {
    const threadParams = {
      model: this.config.model,
      modelProvider: "stargate",
      cwd: this.config.directory,
      approvalPolicy: "never",
      sandbox: this.config.sandbox,
    };

    const threadRaw = mapped
      ? await client.request(
          "thread/resume",
          { ...threadParams, threadId: mapped, excludeTurns: true },
          30_000,
        )
      : await client.request("thread/start", threadParams, 30_000);

    const threadDecoded = Option.getOrUndefined(
      decodeThreadResponse(threadRaw),
    );

    if (!threadDecoded || !isID(threadDecoded.thread.id)) {
      throw new CodexTurnError("Codex thread identity is not valid");
    }

    const threadId = threadDecoded.thread.id;

    if (mapped !== undefined && threadId !== mapped) {
      throw new CodexTurnError("Codex thread identity changed");
    }

    return threadId;
  }

  private async prepareTemporaryWorkspace(input: {
    text: string;
    images: Attachment[];
  }): Promise<{ temporary: string; promptItems: CodexAppServerUserInput[] }> {
    let temporary = await mkdtemp(join(tmpdir(), "stargate-codex-"));
    const roots = writableRoots(this.config);

    try {
      temporary = await trustedPath(temporary, roots);
      await checkCodexPaths(this.config, this.data, temporary);

      for (const path of Object.values(codexDirectories(this.data))) {
        if (!(await linkFree(path))) {
          throw new Error("Codex data directories must not be symbolic links");
        }
      }
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
      throw new CodexTurnError((error as Error).message);
    }

    const promptItems: CodexAppServerUserInput[] = [
      { type: "text", text: input.text, text_elements: [] },
    ];

    for (const [index, image] of input.images.entries()) {
      const path = join(
        temporary,
        `attachment-${index + 1}${imageTypes[image.mime]}`,
      );

      await writeFile(path, image.data, { mode: 0o600 });
      promptItems.push({ type: "localImage", path });
    }

    return { temporary, promptItems };
  }

  private async teardownClient(client: CodexAppServerClient | undefined) {
    if (!client) {
      return;
    }

    client.endInput();
    client.closePipes();
    const graceTimer = new AbortController();
    await Promise.race([
      client.done,
      delay(Math.min(this.grace, 250), undefined, {
        signal: graceTimer.signal,
      }).catch(() => {}),
    ]);
    graceTimer.abort();

    if (client.running) {
      client.kill("SIGTERM");
    }
  }

  private async startTurn(
    client: CodexAppServerClient,
    threadId: string,
    inputId: string,
    promptItems: CodexAppServerUserInput[],
  ): Promise<string> {
    const turnRaw = await client.request(
      "turn/start",
      {
        threadId,
        clientUserMessageId: inputId,
        input: promptItems,
        cwd: this.config.directory,
        approvalPolicy: "never",
        sandboxPolicy: codexSandboxPolicy(this.config),
        model: this.config.model,
        effort: this.config.reasoningEffort ?? null,
      },
      30_000,
    );

    const turnDecoded = Option.getOrUndefined(decodeTurnResponse(turnRaw));

    if (!turnDecoded) {
      throw new CodexTurnError("Codex turn/start returned no turn ID");
    }

    return turnDecoded.turn.id;
  }

  private spawnAppServer(
    env: Record<string, string>,
    temporary: string,
    markerValue: string,
    onNotification: (method: string, params: unknown) => void,
    onFailure: () => void,
  ): CodexAppServerClient {
    const childEnv: Record<string, string> = {
      ...env,
      PATH: this.searchPath,
      TMPDIR: temporary,
      [turnVariable]: markerValue,
      ...this.runtime.environment,
    };

    const child = spawn(
      this.cli,
      codexAppServerArgs(codexConfig(this.config)),
      {
        cwd: this.config.directory,
        env: childEnv,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );

    return new CodexAppServerClient(child, onNotification, onFailure);
  }

  public async prompt(
    ...args: Parameters<AgentBackend["prompt"]>
  ): Promise<string> {
    const [
      sessionId,
      text,
      signal,
      onText,
      onInput,
      files = [],
      context,
      onProgress,
      _liveProgress,
      activityRequests,
    ] = args;

    const stage = onProgress
      ? (value: TurnStage) => {
          onProgress({
            stage: value,
            observedAt: Date.now(),
            backend: "codex",
          });
        }
      : undefined;

    signal.throwIfAborted();

    if (this.closed) {
      throw new CodexTurnError("Codex backend is closing");
    }

    if (!isID(sessionId)) {
      throw new CodexTurnError("Codex conversation ID is not valid");
    }

    const id = sessionId;

    if (this.runs.has(id)) {
      throw new CodexTurnError("Codex thread is busy");
    }

    const input = codexInput(
      context ? `${sourceLine(context)}\n\n${text}` : text,
      files,
    );

    const env = codexEnvironment(this.config, this.data);
    const inputId = crypto.randomUUID();

    const run: Run = {
      controller: new AbortController(),
      done: Promise.resolve(),
      marker: { variable: turnVariable, value: crypto.randomUUID() },
      since: 0,
      record: join(this.records, `${id}.json`),
      settled: false,
    };

    this.runs.set(id, run);
    const finished = Promise.withResolvers<void>();
    run.done = finished.promise;

    const stop = () => {
      run.controller.abort();
    };

    signal.addEventListener("abort", stop, { once: true });

    let temporary: string | undefined;
    let recorded = false;
    let reaping: Promise<void> | undefined;
    let hardCancelTimer: ReturnType<typeof setTimeout> | undefined;
    const turnDone = Promise.withResolvers<void>();

    const forceCancel = () => {
      clearTimeout(hardCancelTimer);
      run.client?.abort(new CodexTurnError("Codex turn cancelled"));
      run.client?.closePipes();
      run.client?.kill("SIGTERM");
      turnDone.resolve();

      if (!recorded || reaping !== undefined) {
        return;
      }

      reaping = stopTurnProcesses(
        systemProcesses,
        run.marker,
        run.since,
        this.grace,
      ).catch(() => {});
    };

    const cancel = () => {
      if (run.client && run.threadId && run.turnId && !run.settled) {
        const waitMs = Math.min(this.grace, INTERRUPT_GRACE_MS);

        void run.client
          .request(
            "turn/interrupt",
            { threadId: run.threadId, turnId: run.turnId },
            waitMs,
          )
          .catch(() => {})
          .finally(forceCancel);

        hardCancelTimer = setTimeout(forceCancel, waitMs);
        hardCancelTimer.unref?.();

        return;
      }

      forceCancel();
    };

    run.controller.signal.addEventListener("abort", cancel, { once: true });
    const activityLog = this.beginActivity(id, activityRequests);

    try {
      await this.stopOrphan(id, AbortSignal.timeout(5000));
      const prepared = await this.prepareTemporaryWorkspace(input);
      temporary = prepared.temporary;
      const promptItems = prepared.promptItems;

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
      onInput?.(inputId);

      const turn = new CodexTurn(activityLog);
      const buffered: { method: string; params: unknown }[] = [];

      const applyNotification = (method: string, params: unknown) => {
        const ids = notificationIds(params);

        if (run.threadId === undefined || ids.threadId !== run.threadId) {
          return;
        }

        if (run.turnId === undefined) {
          buffered.push({ method, params });

          return;
        }

        if (ids.turnId !== run.turnId) {
          return;
        }

        const changed = turn.addNotification(method, params, stage);

        if (changed && onText) {
          const visible = turn.answer();

          if (visible) {
            onText(visible);
          }
        }

        if (turn.result) {
          run.settled = true;
          turnDone.resolve();
        }
      };

      const client = this.spawnAppServer(
        env,
        temporary,
        run.marker.value,
        applyNotification,
        () => {
          turnDone.resolve();
        },
      );

      run.client = client;

      await client.request(
        "initialize",
        {
          clientInfo: { name: "stargate", title: "Stargate", version: "0.1.0" },
          capabilities: null,
        },
        30_000,
      );
      client.notify("initialized", {});

      const threadId = await this.openThread(client, mapped);
      run.threadId = threadId;
      signal.throwIfAborted();
      run.controller.signal.throwIfAborted();

      const turnId = await this.startTurn(
        client,
        threadId,
        inputId,
        promptItems,
      );

      if (mapped === undefined) {
        writeFileSync(
          join(this.threads, `${id}.json`),
          JSON.stringify({ thread: threadId }),
          { mode: 0o600 },
        );
      }

      run.turnId = turnId;

      for (const frame of buffered.splice(0)) {
        applyNotification(frame.method, frame.params);
      }

      if (!turn.result) {
        await turnDone.promise;
      }

      run.settled = true;
      signal.throwIfAborted();

      if (!turn.result) {
        throw new BackendFailure("crash", crashed);
      }

      if (!turn.result.ok) {
        throw turn.failure
          ? new BackendFailure(turn.failure.kind, {
              status: turn.failure.status,
              ran: turn.worked,
            })
          : new CodexTurnError("Codex turn failed");
      }

      activityLog?.end("completed");

      return turn.answer();
    } catch (error) {
      activityLog?.end(signal.aborted ? "cancelled" : "failed");
      signal.throwIfAborted();

      if (
        error instanceof AttachmentInputUnavailable ||
        error instanceof BackendFailure ||
        error instanceof CodexTurnError
      ) {
        throw error;
      }

      if (error instanceof CodexAppServerRpcError) {
        const failure = codexFailureKind(error.errorMessage);

        if (failure) {
          throw new BackendFailure(failure.kind, {
            status: failure.status,
            ran: false,
          });
        }
      }

      throw new BackendFailure("crash", crashed);
    } finally {
      clearTimeout(hardCancelTimer);
      signal.removeEventListener("abort", stop);
      run.controller.signal.removeEventListener("abort", cancel);

      await this.teardownClient(run.client);

      await reaping;

      if (recorded) {
        await stopTurnProcesses(
          systemProcesses,
          run.marker,
          run.since,
          this.grace,
        );
      }

      if (temporary) {
        await rm(temporary, { recursive: true, force: true }).catch(() => {});
      }

      if (recorded) {
        await rm(run.record, { force: true });
      }

      if (this.runs.get(id) === run) {
        this.runs.delete(id);
      }

      finished.resolve();
    }
  }

  private async stopOrphan(id: string, signal: AbortSignal) {
    const path = join(this.records, `${id}.json`);
    let record: typeof recordSchema.Type;

    try {
      record = decodeRecord(JSON.parse(await readFile(path, "utf8")));
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

  public async interrupt(sessionId: string, signal: AbortSignal) {
    if (!isID(sessionId)) {
      return;
    }

    const run = this.runs.get(sessionId);

    if (run) {
      run.controller.abort();
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
    }

    await Promise.all(runs.map((run) => run.done));
  }
}
