import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { secret } from "../lib/credentials";
import { BackendFailure } from "../shared/request-failure";
import {
  type AgentBackend,
  type BackendContext,
  type TurnActivityRecorder,
  sourceLine,
} from "./backend";
import { stopTurnGroup, stopTurnProcesses, systemProcesses } from "./cli-agent";
import { acpPromptBlocks } from "./acp";
import { type AcpRunSpec, acpTurnVariable, runAcpTurn } from "./acp/runtime";
import type { AntigravityBackendConfig } from "./config";
import {
  ANTIGRAVITY_AUTH_STDOUT_PREFIX,
  type AntigravityProfile,
  antigravityEnvironment,
  antigravitySessionMeta,
  antigravitySessionMode,
  antigravitySpawnArgs,
  isAntigravitySignInRequiredError,
  prepareAntigravityProfile,
  resolveAntigravityModel,
  verifyAntigravityExecutable,
} from "./antigravity/support";

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

class AntigravityTurnError extends Error {}

export type AntigravityRuntimeOverrides = {
  readonly graceMs?: number | undefined;
  readonly startupTimeoutMs?: number | undefined;
  readonly versionTimeoutMs?: number | undefined;
  readonly skipVersionCheck?: boolean | undefined;
};

type ActiveRun = {
  readonly controller: AbortController;
  done: Promise<void>;
};

/**
 * Google Antigravity ACP backend (`agy acp` >= 1.5.1). Runs on Stargate's ACP
 * runtime with an isolated private `GEMINI_HOME`, browser suppression,
 * fail-closed permissions, and version verification.
 */
export class AntigravityBackend implements AgentBackend {
  public readonly supportsAttachments = true;
  private readonly runs = new Map<string, ActiveRun>();
  private closed = false;
  private versionChecked = false;

  private constructor(
    private readonly config: AntigravityBackendConfig,
    private readonly profile: AntigravityProfile,
    private readonly sessionsDir: string,
    private readonly recordsDir: string,
    private readonly overrides: AntigravityRuntimeOverrides,
    private readonly activity?: TurnActivityRecorder,
  ) {}

  private get graceMs(): number {
    return this.overrides.graceMs ?? 5000;
  }

  public static async open(
    config: AntigravityBackendConfig,
    context: BackendContext,
    overrides: AntigravityRuntimeOverrides = {},
  ): Promise<AntigravityBackend> {
    if (config.auth.method === "gemini-api-key") {
      secret(config.auth.apiKeyEnv);
    } else if (
      config.auth.method === "agent-platform" &&
      config.auth.apiKeyEnv !== undefined
    ) {
      secret(config.auth.apiKeyEnv);
    }

    const profile = await prepareAntigravityProfile(
      context.dataDirectory,
      config.auth,
    );

    const sessionsDir = join(context.dataDirectory, "antigravity-sessions");
    const recordsDir = join(context.dataDirectory, "antigravity-runs");

    for (const dir of [sessionsDir, recordsDir]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
    }

    return new AntigravityBackend(
      config,
      profile,
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
      return Promise.reject(
        new AntigravityTurnError("Antigravity backend is closing"),
      );
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
      throw new AntigravityTurnError("Antigravity backend is closing");
    }

    if (!isUUID(sessionId)) {
      throw new AntigravityTurnError("Antigravity session ID is not valid");
    }

    if (this.runs.has(sessionId)) {
      throw new AntigravityTurnError("Antigravity session is busy");
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

      const turnMarker = crypto.randomUUID();

      const env = {
        ...antigravityEnvironment(this.config, this.profile),
        [acpTurnVariable]: turnMarker,
      };

      if (!this.versionChecked && !this.overrides.skipVersionCheck) {
        await verifyAntigravityExecutable(
          this.config.executable,
          this.config.directory,
          env,
          controller.signal,
          this.overrides.versionTimeoutMs,
        );
        this.versionChecked = true;
      }

      controller.signal.throwIfAborted();
      const inputId = crypto.randomUUID();
      onInput?.(inputId);

      const nativeSessionId = await this.readNativeSession(sessionId);

      const spec: AcpRunSpec = {
        sessionId,
        nativeSessionId,
        command: this.config.executable,
        args: antigravitySpawnArgs(this.config, this.profile),
        cwd: this.config.directory,
        env,
        prompt,
        flavor: "generic",
        backendTag: "antigravity",
        permissionPolicy: this.config.permissionPolicy,
        extraRoots: this.config.extraRoots,
        model: this.config.model,
        reasoningEffort: this.config.thinkingLevel,
        mode: "default",
        authMethodId: this.config.auth.method,
        authenticateEagerly: true,
        resumeMethod: "resume",
        cancelBehavior: "wait-for-prompt",
        recordPath: join(this.recordsDir, `${sessionId}.json`),
        turnMarker,
        graceMs: this.graceMs,
        startupTimeoutMs: this.overrides.startupTimeoutMs,
        sessionMeta: (init) =>
          antigravitySessionMeta(init, this.config.systemPrompt),
        resolveMode: antigravitySessionMode,
        resolveModel: resolveAntigravityModel,
        interceptStdoutLine: (line, abort) => {
          if (line.startsWith(ANTIGRAVITY_AUTH_STDOUT_PREFIX)) {
            abort(new BackendFailure("auth", { ran: false }));

            return "consume";
          }

          return "pass";
        },
        classifyError: (error, ran) =>
          isAntigravitySignInRequiredError(error)
            ? new BackendFailure("auth", { ran })
            : undefined,
        onText,
        onProgress,
        activity: this.activity,
        activityRequests,
        signal: controller.signal,
      };

      const outcome = await runAcpTurn(spec);
      await this.writeNativeSession(sessionId, outcome.nativeSessionId);

      return outcome.answer;
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

      throw new AntigravityTurnError(
        "Antigravity session mapping is unreadable",
      );
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
