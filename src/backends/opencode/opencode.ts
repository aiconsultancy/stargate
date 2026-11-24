import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
  OpenCode,
  type OpenCodeClient,
  type SessionMessageInfo,
  isAgentNotFoundError,
  isSessionNotFoundError,
} from "@opencode/client";
import { SessionMessage } from "@opencode/schema";
import { Schema } from "effect";
import {
  type ActivityWatch,
  activitySnapshotSchema,
} from "../../activity/activity";
import {
  type Attachment,
  checkAttachments,
} from "../../attachments/attachments";
import {
  type AgentBackend,
  type PromptSourceContext,
  type SteerInput,
  type SteerResult,
  type TextSink,
  type Transcript,
  type TranscriptEntry,
  TranscriptUnavailable,
  latestInput,
  sourceLine,
} from "../backend";
import type { opencodeBackendSchema } from "./config";
import { redactCredentials, secret } from "../../lib/credentials";
import { isNativeInstructionContext } from "../../coordination/crew/instruction-context";
import { crewMessageMetadataKey } from "../../coordination/crew/message-protocol";
import { CrewReporting } from "../../coordination/crew/reporting/report-rpc";
import {
  cronEvaluationSchema,
  cronModelSchema,
} from "../../automation/cron/advanced";
import type {
  FleetReviewBinding,
  FleetReviewEvidence,
  NativeMaker,
} from "../../coordination/fleet/protocol";
import {
  reviewContextPrompt,
  reviewNativePrompt,
} from "../../coordination/fleet/reviews";
import {
  InputBoundaryFold,
  type InputBoundaryRecord,
  boundaryRecord,
  closesBoundaryContext,
} from "./input-boundary";
import { InputBoundaryReader, inputOwnership } from "./input-origin";
import {
  MaintenanceRPC,
  type MaintenanceWatch,
  maintenanceNoticeSchema,
} from "../../automation/maintenance/maintenance";
import type { MaintenanceDrain } from "../../automation/maintenance/maintenance-drain";
import type { NativeQuestion } from "../../questions/native-question";
import type { CrewStatusInput } from "../../shared/crew-status";
import { quotaObservationSchema, quotaSnapshotSchema } from "../quota/quota";
import {
  BackendFailure,
  type BackendFailureKind,
  PendingBackendQuestion,
  PromptNotSubmitted,
  connectionFailure,
  statusKind,
} from "../../shared/request-failure";
import type { TurnProgress, TurnStage } from "../../shared/turn-progress";
import type { UpdateSnapshot } from "../../automation/maintenance/update-notice";
import { OpenCodeNotices } from "./notices";
import { OpenCodeCrewStatus } from "./crew-status";
import { OpenCodeHistory } from "./opencode-history";
import { OpenCodeQuestions } from "./questions";

type Config = typeof opencodeBackendSchema.Type;

const pinnedSessionSchema = Schema.Struct({
  id: Schema.String,
  parentID: Schema.optional(Schema.String),
  fork: Schema.optional(Schema.Unknown),
  agent: Schema.optional(Schema.String),
  location: Schema.Struct({ directory: Schema.String }),
  permissions: Schema.optional(
    Schema.Array(
      Schema.Struct({
        action: Schema.String,
        resource: Schema.String,
        effect: Schema.Literals(["allow", "deny", "ask"]),
      }),
    ),
  ),
});

const readyAgentSchema = Schema.Struct({
  location: Schema.Struct({ directory: Schema.String }),
  data: Schema.Struct({ id: Schema.String }),
});

const decodePinnedSession = Schema.decodeUnknownSync(pinnedSessionSchema);
const decodeReadyAgent = Schema.decodeUnknownSync(readyAgentSchema);

const agentReadyMs = 30_000;
const agentReadyPollMs = 250;

const assistantProgress = {
  "session.step.started": "model",
  "session.retry.scheduled": "retry",
  "session.reasoning.started": "reasoning",
  "session.tool.called": "tool",
  "session.text.started": "reply",
} as const satisfies Record<string, TurnStage>;

const previewEvents = ["session.text.delta", "session.text.ended"] as const;
const ownershipRetryMs = 250;

const pairingCode = Schema.Struct({
  code: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,512}$/)),
  expires_in: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 86_400 }),
  ),
});

const decodePairingCode = Schema.decodeUnknownSync(pairingCode);

const settledEvents = [
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const;

function publicEntry(message: SessionMessageInfo): TranscriptEntry | undefined {
  if (message.type !== "assistant") return;

  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();

  return text
    ? { id: message.id, text, created: message.time.created }
    : undefined;
}

/** One assistant message of a turn: its public text and what else it did. */
type Reply = {
  text: string;
  /** Native completion, not just public text or an idle session. */
  succeeded: boolean;
  /** The message has a tool call: the turn did work. */
  tools: boolean;
  error?: { type: string; status?: number | undefined };
};

/**
 * The shared category of a failed generation: from the provider's HTTP
 * status, else from OpenCode's error type name. An interrupted or unknown
 * failure has none.
 */
function generationFailureKind(error: {
  type: string;
  status?: number | undefined;
}): BackendFailureKind | undefined {
  if (error.status !== undefined) return statusKind(error.status);

  if (/abort|interrupt|cancel/i.test(error.type)) return undefined;

  if (/rate|quota|limit|billing/i.test(error.type)) return "quota";

  if (/auth|credential|forbidden/i.test(error.type)) return "auth";

  if (/timeout/i.test(error.type)) return "timeout";

  if (/connect|network|unreachable/i.test(error.type)) return "network";

  if (/model/i.test(error.type)) return "model";

  if (/provider|api|server|overload/i.test(error.type)) return "provider";

  return undefined;
}

export class OpenCodeBackend implements AgentBackend {
  public async pinnedBackgroundQuestions(signal: AbortSignal) {
    if (!this.sessionID) return [];

    const session = await this.createSession({
      key: this.sessionID,
      title: "",
      signal,
    });

    const forms = await this.pendingQuestions(session, signal);
    const verified: NativeQuestion[] = [];

    for (const q of forms) {
      if ("unsupported" in q) continue;

      const input = await this.client.session.message.get(
        { sessionID: session, messageID: q.inputID },
        { signal },
      );

      if (
        input.id === q.inputID &&
        input.type === "synthetic" &&
        !input.metadata
      )
        verified.push(q);
    }

    return verified;
  }

  /** One gateway-owned attempt; IDs/nonce were persisted before this call. */
  public async startReview(
    binding: FleetReviewBinding,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      binding.reviewer.kind !== "crew" ||
      binding.context.coordinatorSessionID !== this.sessionID
    )
      throw new Error("Review worker does not belong to this native root");
    const reviewer = binding.reviewer;

    const definition = await this.client.agent.get(
      { agentID: reviewer.agent, location: { directory: reviewer.directory } },
      { signal },
    );

    if (
      definition.data.id !== reviewer.agent ||
      definition.location.directory !== reviewer.directory ||
      definition.data.mode !== "primary" ||
      !definition.data.model ||
      !reviewer.models.some(
        (m) =>
          m.provider === definition.data.model?.providerID &&
          m.model === definition.data.model?.id &&
          (m.variant === undefined ||
            m.variant === definition.data.model?.variant),
      )
    )
      throw new Error("Native review profile or model selector is unavailable");
    const active = await this.client.session.active({ signal });
    let cursor: string | undefined;
    const seen = new Set<string>();

    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = await this.client.session.list(
        {
          directory: reviewer.directory,
          limit: 100,
          ...(cursor && { cursor }),
        },
        { signal },
      );

      if (
        page.data.some(
          (s) => s.location.directory === reviewer.directory && active[s.id],
        )
      )
        throw new Error(
          "Configured review worker is busy; no worktree was changed",
        );

      for (const candidate of page.data) {
        if (candidate.location.directory !== reviewer.directory) continue;

        const inbox = await this.client.session.inbox.list(
          { sessionID: candidate.id },
          { signal },
        );

        if (inbox.length > 0)
          throw new Error("Configured review directory has queued native work");
      }

      const next = page.cursor.next;

      if (!next) break;

      if (seen.has(next) || pageNumber === 99)
        throw new Error("Review worker ownership cannot be bounded");
      seen.add(next);
      cursor = next;
    }

    const session = await this.client.session.create(
      {
        id: binding.sessionID,
        agent: reviewer.agent,
        title: `PR review ${binding.context.repository}#${binding.context.pullRequest}`,
        location: { directory: reviewer.directory },
        model: definition.data.model,
        permissions: [
          { action: "*", resource: "*", effect: "deny" },
          ...reviewer.permissions,
        ],
        metadata: {
          stargateReview: {
            id: binding.id,
            nonce: binding.nonce,
            owner: this.sessionID,
            contextDigest: binding.context.contextDigest,
          },
        },
      },
      { signal },
    );

    if (
      session.id !== binding.sessionID ||
      session.agent !== reviewer.agent ||
      session.location.directory !== reviewer.directory
    )
      throw new Error("Native review session identity changed");
    await this.client.session.prompt(
      {
        sessionID: binding.sessionID,
        id: binding.inputID,
        text: reviewNativePrompt(binding),
        metadata: { stargateReview: { id: binding.id, nonce: binding.nonce } },
        delivery: "queue",
        resume: true,
      },
      { signal },
    );
  }

  /** Strict read-only evidence; never reads crew DBs, files, or inferred models. */
  public async readReview(
    binding: FleetReviewBinding,
    signal: AbortSignal,
  ): Promise<FleetReviewEvidence | undefined> {
    if (binding.context.coordinatorSessionID !== this.sessionID)
      throw new Error("Review root mismatch");

    const session = await this.client.session.get(
      { sessionID: binding.sessionID },
      { signal },
    );

    if (
      session.id !== binding.sessionID ||
      session.agent !== binding.reviewer.agent ||
      session.location.directory !== binding.reviewer.directory
    )
      throw new Error("Native reviewer session identity changed");

    if (binding.reviewer.kind === "captain") {
      if (
        binding.sessionID !== this.sessionID ||
        binding.reviewer.agent !== this.config.agent ||
        binding.reviewer.directory !== this.config.directory ||
        session.parentID !== undefined
      )
        throw new Error("Review captain is not the configured root");
    } else {
      const marker = session.metadata?.["stargateReview"];

      if (
        typeof marker !== "object" ||
        marker === null ||
        !("id" in marker) ||
        marker["id"] !== binding.id ||
        !("nonce" in marker) ||
        marker["nonce"] !== binding.nonce ||
        !("owner" in marker) ||
        marker["owner"] !== this.sessionID ||
        !("contextDigest" in marker) ||
        marker["contextDigest"] !== binding.context.contextDigest
      )
        throw new Error("Native worker review ownership unavailable");
    }

    const assistants: {
      maker: NativeMaker;
      completed: boolean;
      failed: boolean;
      finish: string | undefined;
      text: string;
      unsafeTools: boolean;
    }[] = [];

    let cursor: string | undefined;
    const seen = new Set<string>();

    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = await this.client.message.list(
        {
          sessionID: binding.sessionID,
          limit: 100,
          ...(cursor ? { cursor } : { order: "desc" as const }),
        },
        { signal },
      );

      for (const message of page.data) {
        if (message.id === binding.inputID) {
          if (
            message.type !== "user" ||
            (binding.reviewer.kind === "crew"
              ? message.text !== reviewNativePrompt(binding)
              : !message.text.endsWith(
                  reviewContextPrompt(binding.context, binding.contextText),
                ))
          )
            throw new Error(
              "Native review input does not match immutable context",
            );
          const final = assistants[0];

          if (!final) return;

          if (assistants.some((m) => m.failed))
            throw new Error("Native review failed");

          if (assistants.some((m) => m.unsafeTools))
            throw new Error(
              "Native review used a tool outside the read-only review boundary",
            );

          if (assistants.some((m) => !m.completed)) return;

          if (final.finish !== "stop")
            throw new Error("Native review did not finish successfully");
          const resultText = final.text;

          if (
            !resultText.trim() ||
            Buffer.byteLength(resultText, "utf8") > 64_000
          )
            throw new Error("Native review result is missing or oversized");

          return {
            resultText,
            makers: assistants.toReversed().map((m) => m.maker),
          };
        }

        if (message.type === "assistant") {
          if (assistants.length >= 100)
            throw new Error("Native review maker bound exceeded");
          assistants.push({
            maker: {
              messageID: message.id,
              agent: message.agent,
              provider: message.model.providerID,
              model: message.model.id,
              ...(message.model.variant && { variant: message.model.variant }),
            },
            completed: message.time.completed !== undefined,
            failed: message.error !== undefined,
            finish: message.finish,
            text: message.content
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("\n"),
            unsafeTools: message.content.some(
              (part) =>
                part.type === "tool" &&
                ![
                  "read",
                  "glob",
                  "grep",
                  "skill",
                  "fleet_review",
                  "fleet_verify_instruction",
                  "fleet_status",
                  "stargate_history",
                ].includes(part.name),
            ),
          });
        } else if (
          ["user", "shell", "synthetic"].includes(message.type) &&
          !isNativeInstructionContext(message)
        )
          assistants.length = 0;
      }

      const next = page.cursor.next;

      if (!next) return;

      if (seen.has(next))
        throw new Error("Native review history cursor repeated");
      seen.add(next);
      cursor = next;
    }

    throw new Error("Native review history exceeds bounds");
  }

  public async toolBelongsToInput(
    sessionID: string,
    messageID: string,
    inputID: string,
    signal: AbortSignal,
    expected?: { agent: string; id: string; tool: string; input: unknown },
  ) {
    if (sessionID !== this.sessionID) return false;

    if (expected) {
      try {
        const message = await this.client.session.message.get(
          { sessionID, messageID },
          { signal },
        );

        signal.throwIfAborted();

        if (
          message.id !== messageID ||
          message.type !== "assistant" ||
          message.agent !== expected.agent ||
          message.time.completed !== undefined
        )
          return false;

        const tools = message.content
          .filter((part) => part.type === "tool")
          .filter((part) => part.id === expected.id);

        const tool = tools[0];

        if (
          tools.length !== 1 ||
          !tool ||
          tool.name !== expected.tool ||
          tool.state.status !== "running" ||
          tool.time.completed !== undefined ||
          !isDeepStrictEqual(tool.state.input, expected.input)
        )
          return false;
      } catch {
        signal.throwIfAborted();

        return false;
      }
    }

    // Native records prove liveness/correlation only. IPC authority comes from
    // The gateway's independent, root-controlled permission rules.
    return this.followsInput(sessionID, inputID, signal, messageID);
  }
  public async permissionBelongsToInput(
    sessionID: string,
    requestID: string,
    inputID: string,
    signal: AbortSignal,
  ) {
    if (sessionID !== this.sessionID) return false;

    const request = await this.client.permission.get(
      { sessionID, requestID },
      { signal },
    );

    return (
      request.sessionID === sessionID &&
      request.id === requestID &&
      request.source?.type === "tool" &&
      this.followsInput(sessionID, inputID, signal, request.source.messageID)
    );
  }
  public async pendingPermissions(sessionID: string, signal: AbortSignal) {
    if (sessionID !== this.sessionID)
      throw new Error("Permission session mismatch");

    return this.client.permission.list({ sessionID }, { signal });
  }

  public async replyPermission(
    sessionID: string,
    requestID: string,
    decision: "once" | "reject",
    signal: AbortSignal,
  ) {
    if (sessionID !== this.sessionID)
      throw new Error("Permission session mismatch");

    const pending = await this.client.permission.get(
      { sessionID, requestID },
      { signal },
    );

    if (pending.id !== requestID || pending.sessionID !== sessionID)
      throw new Error("Permission request mismatch");
    await this.client.permission.reply(
      { sessionID, requestID, decision },
      { signal },
    );
  }
  public readonly supportsAttachments = true;
  public readonly history: OpenCodeHistory;
  private readonly client;
  private readonly crewStatusProbe: OpenCodeCrewStatus;
  private readonly notices: OpenCodeNotices;
  private readonly questions: OpenCodeQuestions;
  public readonly pendingQuestions;
  public readonly questionState;
  public readonly questionBelongsToInput;
  public readonly backgroundOutcome;
  public readonly replyQuestion;
  public readonly questionInputSettled;
  private readonly waitForIdle;
  private readonly serverClient;
  /** Each session's latest submitted input; re-anchors a lost cursor. */
  private readonly inputs = new Map<string, string>();
  public constructor(
    private readonly config: Config,
    verifiedClient?: OpenCodeClient,
  ) {
    const options = {
      baseUrl: config.url,
      headers: Object.fromEntries(
        Object.entries(config.headersEnv).map(([header, env]) => [
          header,
          secret(env),
        ]),
      ),
    };

    this.client = verifiedClient ?? OpenCode.make(options);
    this.crewStatusProbe = new OpenCodeCrewStatus(
      this.client,
      () => config.directory,
    );
    this.notices = new OpenCodeNotices(this.client, config);
    this.questions = new OpenCodeQuestions(this.client, this.sessionID);
    this.pendingQuestions = this.questions.pendingQuestions.bind(
      this.questions,
    );
    this.questionState = this.questions.questionState.bind(this.questions);
    this.questionBelongsToInput = this.questions.questionBelongsToInput.bind(
      this.questions,
    );
    this.backgroundOutcome = this.questions.backgroundOutcome.bind(
      this.questions,
    );
    this.replyQuestion = this.questions.replyQuestion.bind(this.questions);
    this.questionInputSettled = this.questions.questionInputSettled.bind(
      this.questions,
    );

    // A quiet wait can exceed Bun's HTTP idle timeout. Keep the caller's
    // Stop/deadline signal; leave other requests and pairing policy unchanged.
    this.waitForIdle = OpenCode.make({
      ...options,
      fetch: Object.assign(
        (url: URL | RequestInfo, init?: RequestInit) =>
          fetch(url, { ...init, timeout: false }),
        { preconnect: fetch.preconnect },
      ),
    }).experimental.session.wait;
    this.history = new OpenCodeHistory(this.client, config.directory);
    // Same endpoint and authentication; never forward headers on redirects.
    this.serverClient = OpenCode.make({
      ...options,
      fetch: Object.assign(
        (url: URL | RequestInfo, init?: RequestInit) =>
          fetch(url, { ...init, redirect: "error" }),
        { preconnect: fetch.preconnect },
      ),
    });
  }

  public async serverVersion(signal: AbortSignal) {
    return (await this.serverClient.server.info({ signal })).version;
  }

  public async pair(signal: AbortSignal) {
    try {
      signal.throwIfAborted();

      const result = decodePairingCode(
        await this.serverClient.server.pair({ signal }),
      );

      signal.throwIfAborted();

      return { code: result.code, expiresIn: result.expires_in };
    } catch {
      // SDK failures and validation errors can contain credentials or codes.
      throw new Error("OpenCode pairing failed; outcome may be unknown");
    }
  }

  public crewStatus(input: CrewStatusInput, signal: AbortSignal) {
    return this.crewStatusProbe.crewStatus(input, signal);
  }

  public fleetCrewStatus(input: CrewStatusInput, signal: AbortSignal) {
    return this.crewStatusProbe.fleetCrewStatus(input, signal);
  }

  public updateNoticeContext(
    sessionID: string,
    snapshot: UpdateSnapshot,
    signal: AbortSignal,
  ) {
    return this.notices.updateNoticeContext(sessionID, snapshot, signal);
  }

  public queueUpdateNotice(
    sessionID: string,
    id: string,
    text: string,
    signal: AbortSignal,
  ) {
    return this.notices.queueUpdateNotice(sessionID, id, text, signal);
  }

  public crewUpdateNotice(snapshot: UpdateSnapshot, signal: AbortSignal) {
    return this.notices.crewUpdateNotice(snapshot, signal);
  }

  public maintenanceNotice(record: MaintenanceDrain, signal: AbortSignal) {
    return this.notices.maintenanceNotice(record, signal);
  }

  public resumeMaintenance(signal: AbortSignal) {
    return this.notices.resumeMaintenance(signal);
  }

  public async quota(signal: AbortSignal) {
    try {
      signal.throwIfAborted();

      const result = Schema.decodeUnknownSync(quotaSnapshotSchema)(
        await this.client.rpc(CrewReporting).quota(
          {},
          {
            location: { directory: this.config.directory },
            signal,
          },
        ),
      );

      signal.throwIfAborted();

      return result;
    } catch {
      throw new Error(
        "Quota unavailable; check the captain location and quota configuration.",
      );
    }
  }

  public async cronQuota(signal: AbortSignal) {
    try {
      signal.throwIfAborted();

      const result = Schema.decodeUnknownSync(quotaObservationSchema)(
        await this.client
          .rpc(CrewReporting)
          .cronQuota(
            {},
            { location: { directory: this.config.directory }, signal },
          ),
      );

      signal.throwIfAborted();

      return result;
    } catch {
      throw new Error(
        "Cron quota unavailable; inspect the bound captain configuration.",
      );
    }
  }

  public async cronModel(
    input: Parameters<NonNullable<AgentBackend["cronModel"]>>[0],
    signal: AbortSignal,
  ) {
    try {
      signal.throwIfAborted();

      const result = await this.client.rpc(CrewReporting).cronModel(input, {
        location: { directory: this.config.directory },
        signal,
      });

      signal.throwIfAborted();

      return { model: Schema.decodeUnknownSync(cronModelSchema)(result.model) };
    } catch {
      throw new Error(
        "Cron model validation unavailable; raw details withheld.",
      );
    }
  }

  public async cronEvaluate(
    input: Parameters<NonNullable<AgentBackend["cronEvaluate"]>>[0],
    signal: AbortSignal,
  ) {
    try {
      signal.throwIfAborted();

      const result = await this.client.rpc(CrewReporting).cronEvaluate(input, {
        location: { directory: this.config.directory },
        signal,
      });

      signal.throwIfAborted();
      const evaluation = Schema.decodeUnknownSync(cronEvaluationSchema)(result);

      return {
        ...evaluation,
        text: redactCredentials(evaluation.text, 12_000),
      };
    } catch {
      throw new Error(
        "Cron evaluation unavailable or unconfirmed; do not replay. Raw details withheld.",
      );
    }
  }

  public async createSession(
    input: Parameters<AgentBackend["createSession"]>[0],
  ) {
    try {
      return await this.openSession(input);
    } catch (error) {
      // The server did not answer: no session and no work exist.
      if (!input.signal.aborted && connectionFailure(error))
        throw new BackendFailure("network", { ran: false });
      throw error;
    }
  }

  private async openSession({
    title,
    signal,
  }: Parameters<AgentBackend["createSession"]>[0]) {
    await this.waitForConfiguredAgent(signal);

    if (this.sessionID !== undefined) {
      signal.throwIfAborted();

      try {
        const session = decodePinnedSession(
          await this.client.session.get(
            { sessionID: this.sessionID },
            { signal },
          ),
        );

        signal.throwIfAborted();

        if (
          session.id !== this.sessionID ||
          session.parentID !== undefined ||
          session.fork !== undefined ||
          session.location.directory !== this.config.directory ||
          (this.config.agent !== undefined &&
            session.agent !== this.config.agent) ||
          (this.config.enforcePermissions === true &&
            JSON.stringify(session.permissions) !==
              JSON.stringify(this.config.permissions))
        ) {
          throw new Error("Incompatible pinned session");
        }

        // Operator-selected roots retain their stored model and permissions.
        return this.sessionID;
      } catch {
        signal.throwIfAborted();
        throw new Error("Pinned OpenCode session unavailable or incompatible");
      }
    }

    const session = await this.client.session.create(
      {
        title,
        location: { directory: this.config.directory },
        agent: this.config.agent,
        model: this.config.model,
        permissions: this.config.permissions,
      },
      { signal },
    );

    return session.id;
  }

  /**
   * OpenCode 2.2.7 can expose a partial agent catalogue during plugin activation
   * (anomalyco/opencode#63192). Opt-in fleet profiles must prove their exact
   * agent at the requested location before creating or reusing a root. Never
   * cache this across calls: the native engine may have restarted meanwhile.
   */
  private async waitForConfiguredAgent(signal: AbortSignal) {
    const agentID = this.config.agent;

    if (this.config.enforcePermissions !== true || agentID === undefined)
      return;
    const ready = AbortSignal.any([signal, AbortSignal.timeout(agentReadyMs)]);

    try {
      while (true) {
        ready.throwIfAborted();
        let result: Awaited<ReturnType<typeof this.client.agent.get>>;

        try {
          result = await this.client.agent.get(
            { agentID, location: { directory: this.config.directory } },
            { signal: ready },
          );
        } catch (error) {
          ready.throwIfAborted();

          if (!isAgentNotFoundError(error) || error.agentID !== agentID)
            throw error;
          await delay(agentReadyPollMs, undefined, { signal: ready });
          continue;
        }

        ready.throwIfAborted();
        const agent = decodeReadyAgent(result);

        if (
          agent.data.id !== agentID ||
          agent.location.directory !== this.config.directory
        )
          throw new Error("Configured agent identity or location mismatch");

        return;
      }
    } catch {
      signal.throwIfAborted();
      throw new Error(
        "Configured OpenCode agent unavailable or incompatible; no session was created or reused",
      );
    }
  }

  public get sessionID(): string | undefined {
    return this.config.sessionID;
  }

  public async steer(
    input: SteerInput,
    signal: AbortSignal,
  ): Promise<SteerResult> {
    const { sessionID, inputID, id } = input;

    if (sessionID !== this.sessionID || !input.allowed())
      return { status: "refused" };

    // Forms/permissions are controls, not prompts. An idle or foreign native
    // Input must not receive this message, even when the gateway row is stale.
    try {
      for (const form of await this.client.session.form.list(
        { sessionID },
        { signal },
      )) {
        const detail = await this.client.session.form.get(
          { sessionID, formID: form.id },
          { signal },
        );

        if (detail.state.status === "pending") return { status: "refused" };
      }

      if (
        (await this.client.permission.list({ sessionID }, { signal })).length >
        0
      )
        return { status: "refused" };

      if (!(await this.followsInput(sessionID, inputID, signal)))
        return { status: "refused" };

      if (
        (await this.client.session.inbox.list({ sessionID }, { signal })).some(
          (item) => item.id === inputID,
        )
      )
        return { status: "refused" };
      const active = await this.client.session.active({ signal });
      const session = await this.client.session.get({ sessionID }, { signal });

      if (
        !active[sessionID] ||
        session.id !== sessionID ||
        session.time.busy === undefined ||
        (session.time.idle !== undefined &&
          session.time.idle >= session.time.busy) ||
        !(await this.followsInput(sessionID, inputID, signal)) ||
        !input.allowed()
      )
        return { status: "refused" };
      signal.throwIfAborted();
    } catch {
      // Preflight is read-only: ordinary queue fallback is safe.
      return { status: "refused" };
    }

    try {
      const receipt = await this.client.session.synthetic(
        {
          sessionID,
          id,
          text: `${sourceLine(input.context)}\n\nThread follow-up for the running request:\n${input.text}`,
          description: "Thread follow-up",
          metadata: {
            [crewMessageMetadataKey]: {
              originCaptainID: sessionID,
              originInputID: inputID,
            },
          },
          delivery: "steer",
          resume: false,
        },
        { signal },
      );

      return receipt.id === id &&
        receipt.sessionID === sessionID &&
        receipt.delivery === "steer"
        ? this.reconcileSteer(input, signal)
        : { status: "uncertain" };
    } catch {
      // Even an HTTP error can follow a committed write. Only retained native
      // Evidence can resolve it; never submit again or blindly queue fallback.
      return this.reconcileSteer(input, AbortSignal.timeout(1000));
    }
  }

  public async reconcileSteer(
    input: SteerInput,
    signal: AbortSignal,
  ): Promise<SteerResult> {
    if (input.sessionID !== this.sessionID) return { status: "uncertain" };

    try {
      const message = await this.client.session.message.get(
        {
          sessionID: input.sessionID,
          messageID: input.id,
        },
        { signal },
      );

      const origin = Schema.decodeUnknownSync(
        Schema.Struct({
          originCaptainID: Schema.String,
          originInputID: Schema.String,
        }),
      )(
        message.type === "synthetic"
          ? message.metadata?.[crewMessageMetadataKey]
          : undefined,
      );

      if (
        message.id === input.id &&
        message.type === "synthetic" &&
        origin.originCaptainID === input.sessionID &&
        origin.originInputID === input.inputID
      )
        return { status: "accepted" };
    } catch {
      /* Missing/unreadable history proves neither rejection nor safety. */
    }

    return { status: "uncertain" };
  }

  public async prompt(
    sessionId: string,
    text: string,
    signal: AbortSignal,
    onText?: TextSink,
    onInput?: (id: string) => void,
    files: readonly Attachment[] = [],
    context?: PromptSourceContext,
    onProgress?: (progress: TurnProgress) => void,
    liveProgress = false,
  ) {
    checkAttachments(files);

    if (
      !signal.aborted &&
      context?.source.transport === "irc" &&
      context.source.authority === "human" &&
      !context.source.sender
    ) {
      const check = AbortSignal.any([signal, AbortSignal.timeout(2000)]);

      const waiting = await this.questions
        .waitingForAnswer(sessionId, check)
        .catch(() => false);

      if (signal.aborted)
        throw new PromptNotSubmitted("OpenCode admission check cancelled", {
          cause: signal.reason,
        });

      if (waiting) throw new PendingBackendQuestion();
    }

    this.inputs.delete(sessionId);
    signal.throwIfAborted();
    const stop = new AbortController();
    const timer = new AbortController();
    const connected = Promise.withResolvers<void>();

    type Phase =
      | { type: "attaching" }
      | { type: "submitting"; input: string }
      | { type: "submitted"; input: string }
      | { type: "settled" };

    let phase: Phase = { type: "attaching" };
    // Never reset: once the server accepted the input, the turn can have run.
    let admitted = false;
    const currentPhase = (): Phase => phase;
    const messages = new Map<string, Map<number, string>>();

    const ownership = new Map<
      string,
      "checking" | "owned" | "excluded" | { retryAt: number; delayMs: number }
    >();

    const checks = new Set<Promise<void>>();

    const pendingProgress = new Map<
      string,
      { progress: TurnProgress; order: number }
    >();

    // Reserve orders one and two for submission and its HTTP acknowledgement.
    let eventOrder = 2;
    let publishedOrder = 0;
    let waitingForm: string | undefined;
    const inspectingForms = new Map<string, number>();
    let disconnected = false;
    let lastProgress: TurnProgress | undefined;

    const report = (progress: TurnProgress, order: number) => {
      if (!signal.aborted && order > publishedOrder) {
        publishedOrder = order;
        lastProgress = progress;
        onProgress?.(progress);
      }
    };

    const reportOwned = (assistant: string) => {
      const observed = pendingProgress.get(assistant);

      if (observed) {
        pendingProgress.delete(assistant);
        report(observed.progress, observed.order);
      }
    };

    const publish = () => {
      if (phase.type !== "submitted" || !onText) return;

      const text = [...messages]
        .values()
        .filter(([id]) => ownership.get(id) === "owned")
        .map(([, parts]) =>
          [...parts]
            .toSorted(([a], [b]) => a - b)
            .map(([, text]) => text)
            .join("\n"),
        )
        .toArray()
        .join("\n\n");

      if (text) onText(text);
    };

    // Consume promptly: slow Slack writes must not block the shared event source.
    const watch = onText ?? onProgress;
    const eventSignal = AbortSignal.any([signal, stop.signal]);

    const consumeEvents = async () => {
      for await (const event of this.client.event.subscribe({
        types: [
          ...previewEvents,
          ...(onProgress
            ? ([
                "session.inbox.enqueued",
                "session.inbox.delivered",
                "session.step.started",
                ...(liveProgress
                  ? ([
                      "session.retry.scheduled",
                      "form.created",
                      "form.replied",
                      "form.cancelled",
                    ] as const)
                  : []),
                "session.reasoning.started",
                "session.tool.called",
                "session.text.started",
              ] as const)
            : []),
        ],
        signal: eventSignal,
      })) {
        if (event.type === "server.connected") {
          if (disconnected && lastProgress) onProgress?.(lastProgress);
          disconnected = false;
          connected.resolve();
          continue;
        }

        const current = currentPhase();

        if (event.type === "form.replied" || event.type === "form.cancelled") {
          if (event.data.sessionID === sessionId)
            inspectingForms.delete(event.data.id);

          if (
            event.data.sessionID === sessionId &&
            event.data.id === waitingForm
          ) {
            waitingForm = undefined;
            report(
              { stage: "clarified", observedAt: Date.now() },
              ++eventOrder,
            );
          }

          continue;
        }

        if (event.type === "form.created") {
          const form = event.data.form;

          if (
            form.sessionID !== sessionId ||
            (current.type !== "submitting" && current.type !== "submitted")
          )
            continue;
          const order = ++eventOrder;
          const observedAt = Date.now();
          inspectingForms.set(form.id, order);

          const check = this.questions
            .nativeQuestion(sessionId, form.id, eventSignal)
            .then((question) => {
              if (
                inspectingForms.get(form.id) === order &&
                question?.inputID === current.input &&
                order > publishedOrder
              ) {
                waitingForm = form.id;
                report({ stage: "waiting", observedAt }, order);
              }
            })
            .catch(() => {})
            .finally(() => {
              if (inspectingForms.get(form.id) === order)
                inspectingForms.delete(form.id);
              checks.delete(check);
            });

          checks.add(check);
          continue;
        }

        if (
          (current.type !== "submitting" && current.type !== "submitted") ||
          event.data.sessionID !== sessionId
        )
          continue;

        if (
          event.type === "session.inbox.enqueued" ||
          event.type === "session.inbox.delivered"
        ) {
          if (event.data.inboxID === current.input)
            report(
              {
                stage:
                  event.type === "session.inbox.enqueued"
                    ? "queued"
                    : "delivered",
                observedAt: Date.now(),
              },
              ++eventOrder,
            );
          continue;
        }

        const { assistantMessageID } = event.data;
        const status = ownership.get(assistantMessageID);

        if (status === "excluded") continue;

        if (
          onProgress &&
          event.type !== "session.text.delta" &&
          event.type !== "session.text.ended"
        ) {
          pendingProgress.set(assistantMessageID, {
            progress: {
              stage: assistantProgress[event.type],
              observedAt: Date.now(),
            },
            order: ++eventOrder,
          });
        }

        if (
          onText &&
          current.type === "submitted" &&
          (event.type === "session.text.delta" ||
            event.type === "session.text.ended")
        ) {
          let parts = messages.get(assistantMessageID);

          if (!parts) {
            parts = new Map();
            messages.set(assistantMessageID, parts);
          }

          const { ordinal } = event.data;
          parts.set(
            ordinal,
            event.type === "session.text.delta"
              ? (parts.get(ordinal) ?? "") + event.data.delta
              : event.data.text,
          );
        } else if (!onProgress) continue;

        if (status === "owned") {
          reportOwned(assistantMessageID);
          publish();
        } else if (
          status === undefined ||
          (typeof status === "object" &&
            event.type !== "session.text.delta" &&
            Date.now() >= status.retryAt)
        ) {
          ownership.set(assistantMessageID, "checking");
          // Events identify the session and assistant, not its input.
          // Only transcript placement proves this is not a queued prior turn.
          const readSignal = AbortSignal.any([signal, stop.signal]);

          const readOwner = () =>
            inputOwnership(
              this.client,
              sessionId,
              current.input,
              readSignal,
              assistantMessageID,
            ).catch(() => {});

          const check = readOwner()
            .then(async (owned) => {
              // First observations can lead the history projection. Later
              // State changes can retry with backoff without polling deltas.
              if (owned !== undefined || !onProgress || status !== undefined)
                return owned;
              await delay(ownershipRetryMs, undefined, {
                signal: readSignal,
              });

              return readOwner();
            })
            .then((owned) => {
              if (owned === undefined && onProgress) {
                const delayMs =
                  typeof status === "object"
                    ? status.delayMs
                    : ownershipRetryMs;

                ownership.set(assistantMessageID, {
                  retryAt: Date.now() + delayMs,
                  delayMs: Math.min(delayMs * 2, 10_000),
                });

                return;
              }

              ownership.set(assistantMessageID, owned ? "owned" : "excluded");

              if (owned) {
                if (currentPhase().type !== "settled")
                  reportOwned(assistantMessageID);
                publish();
              } else {
                pendingProgress.delete(assistantMessageID);
                messages.delete(assistantMessageID);
              }
            })
            .catch(() => {})
            .finally(() => {
              checks.delete(check);
            });

          checks.add(check);
        }
      }
    };

    const events = watch
      ? (async () => {
          let retryMs = 250;

          while (!eventSignal.aborted) {
            // The SDK closes subscribers when its underlying stream ends.
            // Reattach progress observation, never replay the native prompt.
            await consumeEvents().catch(() => {});

            if (liveProgress && !eventSignal.aborted && lastProgress) {
              disconnected = true;
              onProgress?.({ ...lastProgress, disconnected: true });
            }

            connected.resolve();

            if (!onProgress || eventSignal.aborted) return;
            await delay(retryMs, undefined, { signal: eventSignal });
            retryMs = Math.min(retryMs * 2, 10_000);
          }
        })().catch(() => {})
      : Promise.resolve();

    try {
      if (watch) {
        await Promise.race([
          connected.promise,
          delay(2000, undefined, { signal: timer.signal }),
        ]);
        timer.abort();
      }

      signal.throwIfAborted();
      const id = SessionMessage.ID.create();
      onInput?.(id);
      signal.throwIfAborted();
      phase = { type: "submitting", input: id };
      this.inputs.set(sessionId, id);

      if (onProgress)
        report({ stage: "submitting", observedAt: Date.now() }, 1);

      const input = await this.client.session.prompt(
        {
          sessionID: sessionId,
          id,
          text: context ? `${sourceLine(context)}\n\n${text}` : text,
          delivery: "queue",
          ...(files.length > 0 && {
            files: files.map((file) => ({
              name: file.name,
              uri: `data:${file.mime};base64,${Buffer.from(file.data).toString("base64")}`,
              source: { type: "inline" as const },
            })),
          }),
        },
        { signal },
      );

      if (input.id !== id) throw new Error("OpenCode input identity changed");
      phase = { type: "submitted", input: id };
      admitted = true;

      if (onProgress) report({ stage: "accepted", observedAt: Date.now() }, 2);
      await this.waitForIdle({ sessionID: sessionId }, { signal });
      phase = { type: "settled" };

      // Read backwards to the submitted input; do not resend earlier replies.
      const history: (InputBoundaryRecord & {
        reply?: Reply;
      })[] = [];

      const boundaries = new InputBoundaryReader(
        this.client,
        sessionId,
        signal,
      );

      let cursor: string | undefined;
      const cursors = new Set<string>();

      do {
        // A continuation cursor carries the first page's order.
        const page = await this.client.message.list(
          cursor
            ? { sessionID: sessionId, limit: 100, cursor }
            : { sessionID: sessionId, order: "desc", limit: 100 },
          { signal },
        );

        for (const message of page.data) {
          history.push({
            ...(await boundaries.record(message)),
            ...(message.type === "assistant" && {
              reply: {
                succeeded:
                  message.time?.completed !== undefined &&
                  message.finish === "stop" &&
                  message.error === undefined,
                // Status and type only: the message can quote a provider.
                ...(message.error && {
                  error: {
                    type: message.error.type,
                    status: message.error.status,
                  },
                }),
                tools: message.content.some((part) => part.type === "tool"),
                text: message.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n"),
              },
            }),
          });

          if (message.id === input.id) {
            const fold = new InputBoundaryFold();
            let owner: string | undefined;
            const replies: Reply[] = [];

            for (const record of history.toReversed()) {
              owner = fold.next(record) ?? owner;

              if (record.reply && owner === input.id)
                replies.push(record.reply);
            }

            let failed: Reply["error"];

            for (const reply of replies) {
              // Only a later successful completion of this input supersedes
              // An earlier failed attempt. A subsequent error still fails.
              if (reply.error) failed ??= reply.error;
              else if (reply.succeeded) failed = undefined;
            }

            if (failed) {
              const kind = generationFailureKind(failed);
              throw kind
                ? new BackendFailure(kind, {
                    status: failed.status,
                    ran: replies.some((reply) => reply.tools),
                  })
                : new Error("OpenCode generation failed");
            }

            return replies.map((reply) => reply.text).join("\n\n");
          }
        }

        cursor = page.cursor.next ?? undefined;

        if (cursor && cursors.has(cursor))
          throw new Error("OpenCode history cursor repeated");

        if (cursor) cursors.add(cursor);
      } while (cursor);

      throw new Error("OpenCode input was not found in session history");
    } catch (error) {
      // Correlate a lost admission response without submitting again. A known
      // ID permits withdrawal, but only readable placement permits interruption.
      if (phase.type === "submitting" || phase.type === "submitted") {
        const input = phase.input;
        const cleanup = AbortSignal.timeout(5000);
        await this.interruptInput(sessionId, input, cleanup).catch(() => {});
      }

      // The server went away. Nothing ran only when the input was never
      // Sent: before submission, or when the submission made no connection.
      // After admission, also while history is read, work can have run.
      const connection = signal.aborted ? undefined : connectionFailure(error);

      if (connection)
        throw new BackendFailure("network", {
          ran:
            admitted ||
            (currentPhase().type === "submitting" && connection === "lost"),
        });
      throw error;
    } finally {
      phase = { type: "settled" };
      timer.abort();
      stop.abort();
      await events;
      await Promise.all(checks);
    }
  }

  /** Descending history places an assistant strictly after our delivered input.
   * Missing/unreadable placement suppresses previews; never infer from event time.
   */
  private async followsInput(
    sessionID: string,
    input: string,
    signal: AbortSignal,
    assistant?: string,
  ) {
    return (
      (await inputOwnership(
        this.client,
        sessionID,
        input,
        signal,
        assistant,
      )) === true
    );
  }

  public async close() {
    // Attached OpenCode service belongs to its operator, not Stargate.
  }

  public async executionMakers(
    sessionID: string,
    inputID: string,
    signal: AbortSignal,
  ): Promise<NativeMaker[]> {
    if (this.sessionID !== sessionID)
      throw new Error("Fleet maker session is not pinned");
    const { time } = await this.client.session.get({ sessionID }, { signal });

    const idle =
      time.idle !== undefined && time.idle >= (time.busy ?? 0)
        ? time.idle
        : undefined;

    const messages: (InputBoundaryRecord & {
      maker?: NativeMaker;
      settled: boolean;
    })[] = [];

    const boundaries = new InputBoundaryReader(this.client, sessionID, signal);
    let cursor: string | undefined;
    const cursors = new Set<string>();

    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = await this.client.message.list(
        cursor
          ? { sessionID, limit: 100, cursor }
          : { sessionID, order: "desc", limit: 100 },
        { signal },
      );

      for (const message of page.data) {
        messages.push({
          ...(await boundaries.record(message)),
          settled:
            message.type !== "assistant" ||
            message.time.completed !== undefined ||
            message.error !== undefined ||
            (idle !== undefined && message.time.created <= idle),
          ...(message.type === "assistant" && {
            maker: {
              messageID: message.id,
              agent: message.agent,
              provider: message.model.providerID,
              model: message.model.id,
              ...(message.model.variant && { variant: message.model.variant }),
            },
          }),
        });

        if (message.id !== inputID) continue;

        if (boundaryRecord(message, sessionID).input !== inputID)
          throw new Error("Fleet native input is not a request boundary");
        const fold = new InputBoundaryFold();
        let owner: string | undefined;
        const makers: NativeMaker[] = [];

        for (const entry of messages.toReversed()) {
          owner = fold.next(entry) ?? owner;

          if (entry.maker && owner === inputID && entry.settled)
            makers.push(entry.maker);
        }

        if (makers.length === 0 || makers.length > 100)
          throw new Error(
            "Native fleet maker evidence is unavailable or exceeds bounds",
          );

        return makers;
      }

      cursor = page.cursor.next ?? undefined;

      if (!cursor || cursors.has(cursor)) break;
      cursors.add(cursor);
    }

    throw new Error("Native fleet input was not found");
  }

  public async interrupt(sessionId: string, signal: AbortSignal) {
    try {
      await this.client.session.interrupt({ sessionID: sessionId }, { signal });
    } catch (error) {
      // A deleted session has no work left to stop; startup recovery proceeds.
      // Typed SDK error only; never parse raw messages.
      if (!isSessionNotFoundError(error)) throw error;
    }
  }

  public async interruptInput(
    sessionId: string,
    inputId: string,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    // Exact withdrawal cannot cancel another queued input. Placement can race
    // It, so only the latest raw input, not a settled transcript, permits stop.
    await this.client.session.inbox
      .cancel({ sessionID: sessionId, inboxID: inputId }, { signal })
      .catch(() => {});
    signal.throwIfAborted();

    if (await this.followsInput(sessionId, inputId, signal))
      await this.interrupt(sessionId, signal);
  }

  public async startMaintenance(
    sessionID: string,
    requestID: string,
    signal: AbortSignal,
  ): Promise<MaintenanceWatch> {
    const rpc = this.client.rpc(MaintenanceRPC);
    const owner = { sessionID, id: requestID };

    const options = (signal: AbortSignal) => ({
      location: { directory: this.config.directory },
      signal,
    });

    if (!(await rpc.open(owner, options(signal))))
      throw new Error("Maintenance gateway registration failed");

    return {
      read: async (signal) =>
        Schema.decodeUnknownSync(Schema.NullOr(maintenanceNoticeSchema))(
          await rpc.read(owner, options(signal)),
        ),
      delivered: async (noticeID, signal) => {
        if (!(await rpc.delivered({ ...owner, noticeID }, options(signal))))
          throw new Error("Maintenance delivery unconfirmed");
      },
      close: async (signal) => {
        await rpc.close(owner, options(signal));
      },
    };
  }

  public async transcript(
    sessionID: string,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<Transcript> {
    const after = cursor === latestInput ? this.inputs.get(sessionID) : cursor;

    if (cursor === latestInput && after === undefined)
      throw new TranscriptUnavailable("cursor");

    try {
      return await this.readTranscript(sessionID, after, signal);
    } catch (error) {
      // Typed SDK error only; never parse raw messages.
      if (isSessionNotFoundError(error))
        throw new TranscriptUnavailable("session");
      throw error;
    }
  }

  private async readTranscript(
    sessionID: string,
    after: string | undefined,
    signal: AbortSignal,
  ): Promise<Transcript> {
    const boundaries = new InputBoundaryReader(this.client, sessionID, signal);

    // Quiet threads: one small page proves nothing follows the cursor.
    if (after) {
      const newest = await this.client.message.list(
        { sessionID, order: "desc", limit: 1 },
        { signal },
      );

      if (newest.data[0]?.id === after) return { cursor: after, entries: [] };
    }

    // Read idle state first: later text cannot belong to an earlier execution.
    const { time } = await this.client.session.get({ sessionID }, { signal });

    const idle =
      time.idle !== undefined && time.idle >= (time.busy ?? 0)
        ? time.idle
        : undefined;

    // An idle session has finished every earlier message, even without a mark.
    const settled = (message: SessionMessageInfo) =>
      message.type !== "assistant" ||
      message.time.completed !== undefined ||
      message.error !== undefined ||
      (idle !== undefined && message.time.created <= idle);

    // Keep compact records; long gaps must not retain tool payloads.
    const newer: (InputBoundaryRecord & {
      settled: boolean;
      entry?: TranscriptEntry;
    })[] = [];

    const context: InputBoundaryRecord[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let reached = false;
    let selected = false;
    let needContext = false;

    const startsWithSynthetic = () => {
      const oldest = newer.findLast(
        (message) =>
          message.input !== undefined || message.type === "assistant",
      );

      return oldest?.type === "synthetic" && oldest.input !== undefined;
    };

    // Every page up to the cursor; the caller's signal bounds the work.
    for (;;) {
      signal.throwIfAborted();

      const result = await this.client.message.list(
        cursor
          ? { sessionID, limit: 100, cursor }
          : { sessionID, order: "desc", limit: 20 },
        { signal },
      );

      for (const message of result.data) {
        const record = await boundaries.record(message);

        if (selected) {
          if (record.input !== undefined || record.type === "assistant")
            context.push(record);

          if (closesBoundaryContext(record)) {
            needContext = false;
            break;
          }

          continue;
        }

        if (message.id === after) {
          reached = true;
          selected = true;
          context.push(record);
          needContext =
            record.type === "synthetic" ||
            (!closesBoundaryContext(record) && startsWithSynthetic());

          if (!needContext) break;
          continue;
        }

        const entry = publicEntry(message);
        newer.push({
          ...record,
          settled: settled(message),
          ...(entry && { entry }),
        });
      }

      if (after === undefined && !selected) {
        selected = true;
        needContext = startsWithSynthetic();
      }

      cursor = result.cursor.next ?? undefined;

      if ((selected && !needContext) || !cursor) break;

      if (cursors.has(cursor))
        throw new Error("OpenCode history cursor repeated");
      cursors.add(cursor);
    }

    // Keep the stored cursor; skipping unread history would lose replies.
    if (after && !reached) throw new TranscriptUnavailable("cursor");
    const chronological = newer.toReversed();
    const open = chronological.findIndex((message) => !message.settled);
    const done = open === -1 ? chronological : chronological.slice(0, open);
    const head = done.at(-1)?.id;
    const fold = new InputBoundaryFold();
    let input: string | undefined;

    const reanchor =
      context[0]?.id === after && context[0]?.type === "synthetic";

    for (const message of context.toReversed()) {
      const boundary = fold.next(message);

      // Re-anchor cursor-only wakes, including an undelivered mixed batch.
      if (reanchor) input = boundary ?? input;
    }

    const entries: TranscriptEntry[] = [];

    for (const message of done) {
      input = fold.next(message) ?? input;

      if (message.entry)
        entries.push({
          ...message.entry,
          ...(input !== undefined && { input }),
        });
    }

    if (after !== undefined)
      return {
        cursor: head ?? after,
        entries,
        ...(input !== undefined && { input }),
        ...(open !== -1 && { pending: true as const }),
      };

    // A baseline never delivers earlier history.
    if (head === undefined && cursor)
      throw new Error("OpenCode transcript baseline unavailable");

    return {
      cursor: head ?? "",
      entries: [],
      ...(input !== undefined && { input }),
    };
  }

  public async watch(
    onSettled: (sessionId?: string) => void,
    signal: AbortSignal,
    onForm?: () => void,
  ): Promise<void> {
    let wait = 1000;

    while (!signal.aborted) {
      try {
        for await (const event of this.client.event.subscribe({
          types: onForm
            ? [
                ...settledEvents,
                "form.created",
                "form.replied",
                "form.cancelled",
              ]
            : settledEvents,
          signal,
        })) {
          if (event.type === "server.connected") {
            wait = 1000;
            onSettled();
            onForm?.();
          } else if (event.type === "form.created") {
            if (event.data.form.sessionID === this.sessionID) onForm?.();
          } else if (
            event.type === "form.replied" ||
            event.type === "form.cancelled"
          ) {
            if (event.data.sessionID === this.sessionID) onForm?.();
          } else if (
            event.type === "session.execution.succeeded" ||
            event.type === "session.execution.failed" ||
            event.type === "session.execution.interrupted"
          )
            onSettled(event.data.sessionID);
        }
      } catch {
        // Reconnect below; SDK errors can contain request details.
      }

      await delay(wait, undefined, { signal }).catch(() => {});
      wait = Math.min(30_000, wait * 2);
    }
  }

  public async startActivity(
    sessionID: string,
    requestID: string,
    reporter: string | undefined,
    signal: AbortSignal,
  ): Promise<ActivityWatch> {
    const rpc = this.client.rpc(CrewReporting);

    const options = (signal: AbortSignal) => ({
      location: { directory: this.config.directory },
      signal,
    });

    const capture = Schema.decodeUnknownSync(activitySnapshotSchema)(
      await rpc.start(
        { sessionID, requestID, ...(reporter && { reporter }) },
        options(signal),
      ),
    );

    return this.resumeActivity(sessionID, capture.id);
  }

  public resumeActivity(sessionID: string, capture: string): ActivityWatch {
    const rpc = this.client.rpc(CrewReporting);

    const options = (signal: AbortSignal) => ({
      location: { directory: this.config.directory },
      signal,
    });

    const owner = { sessionID, id: capture };

    const snapshot = async (request: Promise<unknown>) => {
      const value = Schema.decodeUnknownSync(activitySnapshotSchema)(
        await request,
      );

      if (value.id !== capture)
        throw new Error("Crew activity capture changed");

      return value;
    };

    return {
      id: capture,
      read: (signal, passive) =>
        snapshot(
          rpc.read({ ...owner, ...(passive && { passive }) }, options(signal)),
        ),
      finish: (signal) => snapshot(rpc.finish(owner, options(signal))),
      cancel: async (signal) => {
        await rpc.cancel(owner, options(signal));
      },
    };
  }
}
