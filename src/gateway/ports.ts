/**
 * Delivery and transport ports. Transports, delivery helpers and runtime
 * import their contracts from this file; it never imports `gateway.ts`.
 */

import type { ActivityView } from "../activity/activity";
import type { AttachmentTransport } from "../attachments/attachment-delivery";
import type { PromptSourceContext } from "../backend";
import type { QuestionPort } from "../questions/questions";
import type { ReactionName } from "../shared/reactions";
import type { RequestFailure } from "../shared/request-failure";
import type { Identity } from "./routing";
import type { ReplyChunk, SlackContent } from "../shared/slack-format";
import type { Incoming, Job } from "./store-types";
import type { ThreadContext, ThreadContextRequest } from "./thread-context";
import type { TurnProgress } from "../shared/turn-progress";

/** One stored reply chunk of one job. */
export type DeliveryUnit = {
  job: number;
  part: number;
  allowed?: () => boolean;
};

export type IrcTurnStatus = "notice" | "live" | "quiet";
export type RequestOutcome = "completed" | "failed";

/** A verified reaction target a transport may publish a reaction onto. */
export type ReactionTargetRequest = {
  channel: string;
  ts: string;
  appId: string;
  identity: Identity;
  signal: AbortSignal;
};

export interface SlackDelivery {
  /** Undefined (or absent) while the transport cannot move files. */
  readonly files?: AttachmentTransport | undefined;
  /** Replace a preview when ts is set; false means it was removed. */
  failure?(
    channel: string,
    thread: string,
    cause: RequestFailure,
    ts?: string,
  ): Promise<string | false> | Promise<void>;
  activity?(
    channel: string,
    thread: string,
    view: ActivityView,
    ts?: string,
    signal?: AbortSignal,
  ): Promise<string>;
  threadContext?(input: ThreadContextRequest): Promise<ThreadContext>;
  /** Slack user directory, used when an event has no reliable bot marker. */
  userInfo?(user: string, signal: AbortSignal): Promise<unknown>;
  reactionThread?(input: ReactionTargetRequest): Promise<string | undefined>;
  readReceipt?(channel: string, ts: string, active: boolean): Promise<void>;
  ephemeral?(
    channel: string,
    user: string,
    thread: string,
    text: string,
  ): Promise<void>;
  post(
    channel: string,
    thread: string,
    text: string,
    stopJob?: number,
    /** Final delivery of stored chunk `part`: lets a transport keep progress. */
    unit?: DeliveryUnit | { allowed: () => boolean },
    /** Already classified content of `text`; the transport must not reparse. */
    content?: SlackContent,
  ): Promise<string> | Promise<void>;
  /** false means the user removed the preview; post a replacement. */
  update?(
    channel: string,
    ts: string,
    text: string,
    stopJob?: number,
    content?: SlackContent,
  ): Promise<boolean> | Promise<void>;
  remove?(channel: string, ts: string): Promise<void>;
  /**
   * Pure: classify one whole reply once, then split it. Absent transports
   * deliver plain `chunks`/`transcriptChunks` strings.
   */
  prepareReply?(text: string, unbounded?: boolean): ReplyChunk[];
  react?(
    channel: string,
    ts: string,
    name: ReactionName,
    allowed?: () => boolean,
  ): Promise<void>;
  /**
   * Show that a turn is running until `signal` aborts. When requested, send
   * an acknowledgement and backend status notices. Best effort only.
   */
  working?(
    channel: string,
    thread: string,
    signal: AbortSignal,
    allowed?: () => boolean,
    turnStatus?: IrcTurnStatus,
    readProgress?: () => TurnProgress | undefined,
    request?: string,
  ): Promise<void>;
  requestSettled?(
    channel: string,
    request: string,
    outcome: RequestOutcome,
    signal: AbortSignal,
    allowed: () => boolean,
  ): Promise<void>;
}

/** Immutable access context; scheduled/catch-up scopes may have no job. */
export type GatewayAccessContext = Readonly<
  Pick<Incoming, "user" | "channel" | "sender" | "fleet"> &
    Partial<Pick<Incoming, "text" | "eventId">>
>;

/** Transport rules the gateway applies to every job of one registration. */
export interface GatewayTransport {
  /** Clarification channel; never a native permission-approval surface. */
  questions?: QuestionPort;
  /** Session title and source label. */
  readonly name: "slack" | "irc" | "teams";
  /** Queue, session and outbox namespace of this registration. */
  readonly key: string;
  /** Current access rules, rechecked before work and before delivery. */
  allowed(user: string, channel: string, job?: GatewayAccessContext): boolean;
  /** Model-visible source of a chat message; undefined for other jobs. */
  source(input: Incoming): PromptSourceContext["source"] | undefined;
  /** Prompt prefix naming the sender when no source line is sent. */
  note(job: Job): string | undefined;
  instructions?(job: Job): string;
  turnStatus?(job: Job): IrcTurnStatus | undefined;
  progressRequest?(job: Job): string | undefined;
  /**
   * Best effort, before each turn of an unpinned session (IRC crew: bind
   * the session to its crew member). Never fails or blocks the turn.
   */
  sessionReady?(sessionID: string, signal: AbortSignal): Promise<void>;
}
