import type { ActivityWatch } from "../chat/activity/activity";
import type { Attachment } from "../chat/attachments/attachments";
import type { FleetCrewStatus } from "../coordination/crew/reporting/fleet-status";
import type { CrewStatus, CrewStatusInput } from "../shared/crew-status";
import type { CronAdvanced, CronEvaluation } from "../automation/cron/advanced";
import type {
  FleetReviewBinding,
  FleetReviewEvidence,
  NativeMaker,
} from "../coordination/fleet/protocol";
import { validMsgid } from "../transports/irc/protocol";
import type { MaintenanceWatch } from "../automation/maintenance/maintenance";
import type { MaintenanceDrain } from "../automation/maintenance/maintenance-drain";
import type {
  NativeQuestion,
  PendingQuestion,
  QuestionAnswer,
} from "../chat/questions/native-question";
import type { QuotaObservation, QuotaSnapshot } from "./quota/quota";
import type { InboundReaction } from "../shared/reactions";
import type { SessionHistory } from "../shared/session-history";
import type { TurnProgress } from "../shared/turn-progress";
import type {
  UpdateReceipt,
  UpdateSnapshot,
} from "../automation/maintenance/update-notice";

/** Compact source identity; IRC optionally adds `;r=<encoded thread root>`. */
export function sourceLine({ source }: PromptSourceContext) {
  const value = encodeURIComponent;

  return `s=${source.transport ?? "slack"};c=${value(source.channel)};t=${value(source.thread)};m=${value(source.message)};u=${value(source.user)}${source.sender ? `;k=${source.sender}` : ""}${source.authority ? `;a=${source.authority}` : ""}${source.reference ? `;e=${value(source.reference)}` : ""}${source.transport === "irc" && validMsgid(source.replyParent) ? `;r=${value(source.replyParent)}` : ""}${source.reaction ? `;reaction=${value(source.reaction.name)};action=${source.reaction.action}` : ""}`;
}

/**
 * Permanent transcript failures: the mapped session or the stored cursor no
 * longer exists. Transient read errors stay ordinary errors.
 */
export class TranscriptUnavailable extends Error {
  public constructor(public readonly reason: "session" | "cursor") {
    super(
      reason === "session"
        ? "Mapped session no longer exists"
        : "Transcript cursor is not in session history",
    );
  }
}

/** `after` value for messages after this adapter's latest prompt input. */
export const latestInput = "\u0000latest-input";

/** Model-visible source identity only; never repeat chat history here. */
export type PromptSourceContext = {
  source: {
    /** Absent means Slack. */
    transport?: "irc" | "teams" | "fleet";
    authority?: "human" | "agent" | "context";
    reference?: string;
    channel: string;
    thread: string;
    message: string;
    /** A Slack reaction targets this message; it is not a message of its own. */
    reaction?: Pick<InboundReaction, "name" | "action">;
    /** IRC thread root only; separate from this request's message identity. */
    replyParent?: string;
    user: string;
    /** `captain`: a verified peer captain; `crew`: this ship's IRC account. */
    sender?: "captain" | "crew";
  };
};

export type PendingPermission = {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
};

/** Latest complete visible text for this turn, not reasoning or tool output. */
export type TextSink = (text: string) => void;

/** Refused proves no native write occurred. Uncertain must never be replayed. */
export type SteerResult = { status: "accepted" | "refused" | "uncertain" };

export type SteerInput = {
  sessionID: string;
  inputID: string;
  /** Durable, unique native synthetic ID allocated before admission. */
  id: string;
  text: string;
  context: PromptSourceContext;
  /** Recheck local source, input, access and Stop immediately before writing. */
  allowed(): boolean;
};

/** Public text of one settled assistant message; never reasoning or tools. */
export type TranscriptEntry = {
  id: string;
  text: string;
  created: number;
  /** Proven origin; unknown or mixed adjacent native wakes clear ownership. */
  input?: string;
};

/**
 * Settled entries after a native message cursor, oldest first. `cursor` is the
 * newest settled message ID ("" before the first message). `pending` means
 * unsettled messages follow `cursor`. A cursor missing from readable history
 * is an error, never a silent skip.
 */
export type Transcript = {
  cursor: string;
  entries: TranscriptEntry[];
  /** Last proven/unmapped boundary; absent inherits owner. Synthetic cursors re-anchor. */
  input?: string;
  pending?: true;
};

/** Adapters own their sessions; the gateway owns Slack and durable routing. */
export interface AgentBackend {
  /** Optional text-only delivery into this exact running native input. */
  steer?(input: SteerInput, signal: AbortSignal): Promise<SteerResult>;
  /** Read-only reconciliation, never resubmission after an ambiguous write. */
  reconcileSteer?(input: SteerInput, signal: AbortSignal): Promise<SteerResult>;
  updateNoticeContext?(
    sessionID: string,
    snapshot: UpdateSnapshot,
    signal: AbortSignal,
  ): Promise<UpdateSnapshot>;
  queueUpdateNotice?(
    sessionID: string,
    id: string,
    text: string,
    signal: AbortSignal,
  ): Promise<void>;
  crewUpdateNotice?(
    snapshot: UpdateSnapshot,
    signal: AbortSignal,
  ): Promise<UpdateReceipt[]>;
  /** Passive maintenance-drain notice for the pin and ready crew contexts. */
  maintenanceNotice?(
    record: MaintenanceDrain,
    signal: AbortSignal,
  ): Promise<UpdateReceipt[]>;
  /** Start held crew assignments after a drain; `remaining` are still held. */
  resumeMaintenance?(
    signal: AbortSignal,
  ): Promise<{ resumed: number; remaining: number }>;
  pinnedBackgroundQuestions?(signal: AbortSignal): Promise<NativeQuestion[]>;
  pendingQuestions?(
    sessionID: string,
    signal: AbortSignal,
  ): Promise<PendingQuestion[]>;
  /** Authoritative form existence/state, independently of display filtering. */
  questionState?(
    sessionID: string,
    formID: string,
    signal: AbortSignal,
  ): Promise<"pending" | "resolved" | "missing-session" | "unknown">;
  questionBelongsToInput?(
    sessionID: string,
    formID: string,
    inputID: string,
    fingerprint: string,
    signal: AbortSignal,
  ): Promise<boolean>;
  backgroundOutcome?(
    session: string,
    form: string,
    fingerprint: string,
    signal: AbortSignal,
  ): Promise<"answered" | "cancelled" | undefined>;
  replyQuestion?(
    question: NativeQuestion,
    answer: QuestionAnswer | null,
    signal: AbortSignal,
    allowed?: () => boolean,
  ): Promise<void>;
  questionInputSettled?(
    sessionID: string,
    inputID: string,
    signal: AbortSignal,
  ): Promise<boolean>;
  startReview?(binding: FleetReviewBinding, signal: AbortSignal): Promise<void>;
  readReview?(
    binding: FleetReviewBinding,
    signal: AbortSignal,
  ): Promise<FleetReviewEvidence | undefined>;
  /** Reported native makers for this exact submitted input, never config guesses. */
  executionMakers?(
    sessionID: string,
    inputID: string,
    signal: AbortSignal,
  ): Promise<NativeMaker[]>;
  toolBelongsToInput?(
    sessionID: string,
    messageID: string,
    inputID: string,
    signal: AbortSignal,
    expected?: { agent: string; id: string; tool: string; input: unknown },
  ): Promise<boolean>;
  pendingPermissions?(
    sessionID: string,
    signal: AbortSignal,
  ): Promise<PendingPermission[]>;
  permissionBelongsToInput?(
    sessionID: string,
    requestID: string,
    inputID: string,
    signal: AbortSignal,
  ): Promise<boolean>;
  replyPermission?(
    sessionID: string,
    requestID: string,
    decision: "once" | "reject",
    signal: AbortSignal,
  ): Promise<void>;
  /** Explicit capability: unsupported adapters must not silently drop files. */
  readonly supportsAttachments?: boolean;
  /** Explicit durable identity; the gateway scopes routing to this session. */
  readonly sessionID?: string | undefined;
  createSession(input: {
    key: string;
    title: string;
    signal: AbortSignal;
  }): Promise<string>;
  prompt(
    sessionId: string,
    text: string,
    signal: AbortSignal,
    onText?: TextSink,
    /** Persist the allocated native input ID synchronously before admission. */
    onInput?: (id: string) => void,
    files?: readonly Attachment[],
    context?: PromptSourceContext,
    onProgress?: (progress: TurnProgress) => void,
    liveProgress?: boolean,
  ): Promise<string>;
  interrupt?(sessionId: string, signal: AbortSignal): Promise<void>;
  /** Withdraw this input; interrupt only if raw history proves it is current. */
  interruptInput?(
    sessionId: string,
    inputId: string,
    signal: AbortSignal,
  ): Promise<void>;
  startMaintenance?(
    sessionId: string,
    requestID: string,
    signal: AbortSignal,
  ): Promise<MaintenanceWatch>;
  /**
   * Public assistant text after `after`. Undefined `after` returns only the
   * current baseline; "" reads from the start of the session.
   */
  transcript?(
    sessionId: string,
    after: string | undefined,
    signal: AbortSignal,
  ): Promise<Transcript>;
  /**
   * Report sessions that settle outside prompt calls; no session ID means
   * (re)connected. Resolves after the signal aborts.
   */
  watch?(
    onSettled: (sessionId?: string) => void,
    signal: AbortSignal,
    onForm?: () => void,
  ): Promise<void>;
  startActivity?(
    sessionId: string,
    requestID: string,
    reporter: string | undefined,
    signal: AbortSignal,
  ): Promise<ActivityWatch>;
  resumeActivity?(sessionId: string, capture: string): ActivityWatch;
  /** Sensitive, single-use pairing code. Never pass through model or storage. */
  pair?(signal: AbortSignal): Promise<{ code: string; expiresIn: number }>;
  /** Read-only configured crew status; does not require/create a conversation. */
  crewStatus?(input: CrewStatusInput, signal: AbortSignal): Promise<CrewStatus>;
  /** Private fleet metadata from the same location-scoped crew status read. */
  fleetCrewStatus?(
    input: CrewStatusInput,
    signal: AbortSignal,
  ): Promise<FleetCrewStatus | undefined>;
  /** Sanitized subscription limits; never runs a model or creates a session. */
  quota?(signal: AbortSignal): Promise<QuotaSnapshot>;
  cronQuota?(signal: AbortSignal): Promise<QuotaObservation>;
  /** Validates one configured live cron route without changing the captain. */
  cronModel?(
    input: Pick<CronAdvanced, "model" | "arbiter">,
    signal: AbortSignal,
  ): Promise<{ model: string }>;
  /** Tools-off isolated evaluation; caller claims the run before admission. */
  cronEvaluate?(
    input: { id: string; prompt: string } & Pick<
      CronAdvanced,
      "model" | "arbiter"
    >,
    signal: AbortSignal,
  ): Promise<CronEvaluation>;
  /** Read-only transcripts for operator views; never prompts or mutates. */
  readonly history?: SessionHistory;
  close(): Promise<void>;
}

type CrewBinding = {
  authorize(conversationID: string): void;
  run(
    name: string,
    input: unknown,
    conversationID: string,
    id: string,
    signal: AbortSignal,
  ): Promise<unknown>;
};

export type BackendContext = {
  dataDirectory: string;
  crew?: CrewBinding;
  workingAgreement?: { path: string; owns(conversationID: string): boolean };
};
