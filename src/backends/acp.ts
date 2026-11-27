import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import {
  type Attachment,
  checkAttachments,
} from "../chat/attachments/attachments";
import { secret } from "../lib/credentials";
import {
  AttachmentInputUnavailable,
  BackendFailure,
} from "../shared/request-failure";
import {
  type AgentBackend,
  type BackendContext,
  type TurnActivityRecorder,
  sourceLine,
} from "./backend";
import {
  inherited,
  isTextAttachment,
  stopTurnGroup,
  stopTurnProcesses,
  systemProcesses,
  textAttachment,
} from "./cli-agent";
import type { AcpBackendConfig } from "./config";
import type { AcpContentBlock } from "./acp/protocol";
import {
  type AcpRunSpec,
  acpTurnVariable,
  isCopilotLostSessionError,
  runAcpTurn,
} from "./acp/runtime";

const maximumID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

const uuidSchema = Schema.String.check(
  Schema.isUUID(),
  Schema.makeFilter((id) => id.toLowerCase() !== maximumID || id === maximumID),
);

const isUUID = Schema.is(uuidSchema);

const sessionMappingSchema = Schema.Struct({
  nativeSessionId: Schema.String.check(Schema.isMinLength(1)),
});

const decodeSessionMapping = Schema.decodeUnknownSync(sessionMappingSchema, {
  onExcessProperty: "error",
});

const runRecordSchema = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  turn: uuidSchema,
  since: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const decodeRunRecord = Schema.decodeUnknownSync(runRecordSchema, {
  onExcessProperty: "error",
});

class AcpTurnError extends Error {}

const supportedImageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Encode text + Stargate attachments into ACP ContentBlocks; refuse unsupported binaries. */
export function acpPromptBlocks(
  text: string,
  files: readonly Attachment[],
): AcpContentBlock[] {
  try {
    checkAttachments(files);
  } catch {
    throw new AttachmentInputUnavailable(
      "Invalid or oversized ACP attachments",
    );
  }

  const blocks: AcpContentBlock[] = [];

  for (const file of files) {
    if (supportedImageTypes.has(file.mime)) {
      blocks.push({
        type: "image",
        data: Buffer.from(file.data).toString("base64"),
        mimeType: file.mime,
      });
    } else if (file.mime.startsWith("audio/")) {
      blocks.push({
        type: "audio",
        data: Buffer.from(file.data).toString("base64"),
        mimeType: file.mime,
      });
    } else if (isTextAttachment(file)) {
      blocks.push({ type: "text", text: textAttachment(file) });
    } else {
      throw new AttachmentInputUnavailable(
        `ACP backend does not support ${file.mime} attachments`,
      );
    }
  }

  blocks.push({ type: "text", text });

  return blocks;
}

export type AcpRuntimeOverrides = {
  readonly graceMs?: number | undefined;
  readonly startupTimeoutMs?: number | undefined;
  readonly replayIdleMs?: number | undefined;
};

type ActiveRun = {
  readonly controller: AbortController;
  done: Promise<void>;
};

export function acpEnvironment(
  config: AcpBackendConfig,
  parent: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    ...inherited(parent),
    ...config.env,
  };

  for (const [childKey, hostKey] of Object.entries(config.secretEnv)) {
    env[childKey] = secret(hostKey, parent);
  }

  return env;
}

/**
 * Generic Agent Client Protocol (ACP) backend over JSON-RPC 2.0 stdio.
 * Supports session persistence, streaming previews, attachments, fail-closed
 * permissions, cancellation, orphan cleanup, and TurnActivityRecorder.
 */
export class AcpBackend implements AgentBackend {
  public readonly supportsAttachments = true;
  private readonly runs = new Map<string, ActiveRun>();
  private closed = false;

  private constructor(
    private readonly config: AcpBackendConfig,
    private readonly sessionsDir: string,
    private readonly recordsDir: string,
    private readonly overrides: AcpRuntimeOverrides,
    private readonly activity?: TurnActivityRecorder,
  ) {}

  private get graceMs(): number {
    return this.overrides.graceMs ?? 5000;
  }

  public static async open(
    config: AcpBackendConfig,
    context: BackendContext,
    overrides: AcpRuntimeOverrides = {},
  ): Promise<AcpBackend> {
    // Fail at startup when any configured secretEnv reference is missing.
    for (const hostKey of Object.values(config.secretEnv)) {
      secret(hostKey);
    }

    const sessionsDir = join(context.dataDirectory, "acp-sessions");
    const recordsDir = join(context.dataDirectory, "acp-runs");

    for (const dir of [sessionsDir, recordsDir]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
    }

    return new AcpBackend(
      config,
      sessionsDir,
      recordsDir,
      overrides,
      context.activity,
    );
  }

  public createSession({
    signal,
  }: Parameters<AgentBackend["createSession"]>[0]): Promise<string> {
    signal.throwIfAborted();

    if (this.closed) {
      return Promise.reject(new AcpTurnError("ACP backend is closing"));
    }

    return Promise.resolve(crypto.randomUUID());
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

    signal.throwIfAborted();

    if (this.closed) {
      throw new AcpTurnError("ACP backend is closing");
    }

    if (!isUUID(sessionId)) {
      throw new AcpTurnError("ACP session ID is not valid");
    }

    if (this.runs.has(sessionId)) {
      throw new AcpTurnError("ACP session is busy");
    }

    const promptText = context ? `${sourceLine(context)}\n\n${text}` : text;
    const prompt = acpPromptBlocks(promptText, files);
    const controller = new AbortController();
    const finished = Promise.withResolvers<void>();
    const active: ActiveRun = { controller, done: finished.promise };
    this.runs.set(sessionId, active);

    const onAbort = () => {
      controller.abort(signal.reason);
    };

    signal.addEventListener("abort", onAbort, { once: true });

    try {
      await this.stopOrphan(sessionId, AbortSignal.timeout(5000));
      controller.signal.throwIfAborted();
      const inputId = crypto.randomUUID();
      onInput?.(inputId);

      const turnMarker = crypto.randomUUID();

      const env = {
        ...acpEnvironment(this.config),
        [acpTurnVariable]: turnMarker,
      };

      const nativeSessionId = await this.readNativeSession(sessionId);

      let copilotLostSession = false;

      const spec: AcpRunSpec = {
        sessionId,
        nativeSessionId,
        command: this.config.command,
        args: this.config.args,
        cwd: this.config.directory,
        env,
        prompt,
        flavor: this.config.flavor,
        backendTag: "acp",
        permissionPolicy: this.config.permissionPolicy,
        extraRoots: this.config.extraRoots,
        model: this.config.model,
        reasoningEffort: this.config.reasoningEffort,
        mode: this.config.mode,
        authMethodId: this.config.authMethodId,
        resumeMethod: this.config.resumeMethod,
        cancelBehavior: this.config.cancelBehavior,
        recordPath: join(this.recordsDir, `${sessionId}.json`),
        turnMarker,
        graceMs: this.graceMs,
        startupTimeoutMs: this.overrides.startupTimeoutMs,
        replayIdleMs: this.overrides.replayIdleMs,
        classifyError: (error) => {
          if (
            this.config.flavor === "copilot" &&
            isCopilotLostSessionError(error)
          ) {
            copilotLostSession = true;

            return new BackendFailure("crash", { ran: true });
          }

          return;
        },
        onText,
        onProgress,
        activity: this.activity,
        activityRequests,
        signal: controller.signal,
      };

      try {
        const outcome = await runAcpTurn(spec);
        await this.writeNativeSession(sessionId, outcome.nativeSessionId);

        return outcome.answer;
      } catch (error) {
        if (copilotLostSession) {
          await rm(join(this.sessionsDir, `${sessionId}.json`), {
            force: true,
          });
        }

        throw error;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);

      if (this.runs.get(sessionId) === active) {
        this.runs.delete(sessionId);
      }

      finished.resolve();
    }
  }

  public async interrupt(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!isUUID(sessionId)) {
      return;
    }

    const active = this.runs.get(sessionId);

    if (active) {
      active.controller.abort();
      await active.done;

      return;
    }

    await this.stopOrphan(sessionId, signal);
  }

  public async close(): Promise<void> {
    this.closed = true;
    const activeRuns = [...this.runs.values()];

    for (const run of activeRuns) {
      run.controller.abort();
    }

    await Promise.all(activeRuns.map((run) => run.done));
  }

  private async readNativeSession(id: string): Promise<string | undefined> {
    try {
      const raw = await readFile(join(this.sessionsDir, `${id}.json`), "utf8");

      return decodeSessionMapping(JSON.parse(raw)).nativeSessionId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }

      throw new AcpTurnError("ACP session mapping is unreadable");
    }
  }

  private async writeNativeSession(
    id: string,
    nativeSessionId: string,
  ): Promise<void> {
    await writeFile(
      join(this.sessionsDir, `${id}.json`),
      JSON.stringify({ nativeSessionId }),
      { mode: 0o600 },
    );
  }

  private async stopOrphan(id: string, signal: AbortSignal): Promise<void> {
    const path = join(this.recordsDir, `${id}.json`);
    let record: typeof runRecordSchema.Type;

    try {
      record = decodeRunRecord(JSON.parse(await readFile(path, "utf8")));
    } catch {
      return;
    }

    const marker = { variable: acpTurnVariable, value: record.turn };

    const leader = {
      pid: record.pid,
      start: record.since,
      marker,
      session: id,
    };

    await stopTurnGroup(systemProcesses, leader, this.graceMs, signal);
    await stopTurnProcesses(
      systemProcesses,
      marker,
      record.since,
      this.graceMs,
      signal,
    );
    await rm(path, { force: true });
  }
}
