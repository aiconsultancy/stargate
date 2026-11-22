import { setTimeout as delay } from "node:timers/promises";
import { Effect, FiberMap, Schedule } from "effect";
import type { Logger } from "pino";
import {
  ActivityDelivery,
  type ActivityHandle,
} from "../activity/activity-delivery";
import {
  agentFilesLocal,
  deliverAttachments,
} from "../attachments/attachment-delivery";
import {
  type Attachment,
  checkAttachments,
  type PublishedFile,
  parseAttachments,
} from "../attachments/attachments";
import {
  type AgentBackend,
  latestInput,
  type PromptSourceContext,
  type SteerInput,
  type SteerResult,
  sourceLine,
  type Transcript,
  type TranscriptEntry,
  TranscriptUnavailable,
} from "../backend";
import { cancellationTarget } from "./cancellation";
import type { BotConfig } from "../config";
import { abortable, runAbortable } from "../lib/effect";
import { fleetResultSource } from "../fleet/results";
import type {
  GatewayAccessContext,
  GatewayTransport,
  RequestOutcome,
  TransportDelivery,
} from "./ports";
import { maintenanceText, TurnBudget } from "../maintenance/maintenance";
import { startMaintenanceDelivery } from "../maintenance/maintenance-delivery";
import {
  type DrainControl,
  drainNoticeID,
  drainNoticePhase,
  drainNoticeText,
  type MaintenanceDrain,
} from "../maintenance/maintenance-drain";
import { textMentionNote } from "../shared/mentions";
import {
  MetaCommands,
  type MetaOptions,
  metaCandidate,
} from "../meta-commands/meta-commands";
import {
  type NotificationReader,
  notificationNote,
} from "../notifications/preferences/notifications";
import {
  botSender,
  isSlackHuman,
  type PeerDirectory,
  type PeerSender,
  peerLookupMs,
  peerPrefix,
  peerTurnsPerHour,
  peerWindowMs,
} from "./peers";
import { resolveQuestionSettings } from "../questions/question-settings";
import {
  type QuestionPort,
  Questions,
  type questionControl,
} from "../questions/questions";
import { parseReactionReply } from "../shared/reactions";
import {
  AttachmentInputUnavailable,
  BackendFailure,
  failureText,
  PendingBackendQuestion,
  PromptNotSubmitted,
  providerFailure,
  type RequestFailure,
} from "../shared/request-failure";
import {
  botKey,
  chunks,
  conversationKey,
  type Identity,
  isAllowedChannel,
  isAllowedUser,
  routeEvent,
  routeReaction,
  transcriptChunks,
} from "./routing";
import type { SocketRequest } from "../slack/slack";
import { type ReplyChunk, replyText } from "../shared/slack-format";
import { SlackQuestionControls } from "../questions/slack-questions";
import {
  type CaptainCursor,
  type CaptainTranscript,
  type Incoming,
  type Job,
  type JobStatus,
  type Store,
  TranscriptConflict,
} from "./store";
import { LiveReply } from "./streaming";
import { ThreadContextUnavailable, withThreadContext } from "./thread-context";
import {
  isMedia,
  spokenMention,
  spokenMentionNote,
  type Transcriber,
  TranscriptionUnavailable,
  transcribeMedia,
} from "../transcription/transcription";
import { type TurnProgress, turnProgressText } from "../shared/turn-progress";
import type { UpdateReceipt } from "../maintenance/update-notice";
import { botDisplayName, resolveWaiting, waitingPhrase } from "./waiting";

// Catch-up retries read history only; they never prompt the agent.
const retryCeilingMs = 5 * 60 * 1000;
// greybeard: one catch-up may read every page after its cursor within this
// limit. A longer read fails, keeps the cursor and retries; a server-side
// "messages after ID" query is the upgrade path for very long sessions.
const catchUpReadMs = 5 * 60 * 1000;
// Short retries let a just-settled turn receive its final completion mark.
const finalReadDelaysMs = [100, 200, 400];

const gapNote =
  "_Stargate could not find its last delivered message in session history; earlier replies may be missing. This reply starts at your request._";

type FinalTranscript = Transcript & { gap?: true; anchored?: true };

/** True when a settled message of this turn asked for no Slack post. */
function transcriptSilent(entries: readonly TranscriptEntry[]) {
  return entries.some((entry) => parseReactionReply(entry.text).silent);
}

/** Settled public text without reply controls; never applies a reaction. */
export function transcriptReply(entries: readonly TranscriptEntry[]) {
  return entries
    .map((entry) =>
      parseAttachments(parseReactionReply(entry.text).text).text.replace(
        /^(?:\r?\n)+|(?:\r?\n)+$/g,
        "",
      ),
    )
    .filter((text) => text.trim())
    .join("\n\n");
}

/** A message that starts with the silent directive publishes no files. */
export function transcriptAttachments(entries: readonly TranscriptEntry[]) {
  return [
    ...new Map(
      entries
        .flatMap(
          (entry) =>
            parseAttachments(parseReactionReply(entry.text).text).files,
        )
        .map((file) => [file.path, file]),
    ).values(),
  ];
}

/**
 * Registration settings the transport-neutral worker reads. A Slack
 * `BotConfig` carries `slack` and enables Slack-only intake and controls.
 */
export type GatewayConfig =
  | BotConfig
  | (Pick<
      BotConfig,
      | "id"
      | "displayName"
      | "backend"
      | "concurrency"
      | "turnTimeoutMs"
      | "waiting"
      | "crewActivity"
      | "transcription"
    > & { steerThreadFollowUps?: boolean });

type SlackAdmission = (write: () => boolean) => boolean | Promise<boolean>;

/** The failure a thrown error names when no signal ended the turn. */
function errorFailure(error: unknown): RequestFailure {
  if (error instanceof BackendFailure) return error.failure;
  if (error instanceof PendingBackendQuestion) return "pending-question";
  if (error instanceof ThreadContextUnavailable) return "context";
  if (error instanceof AttachmentInputUnavailable) return "attachments";
  if (error instanceof TranscriptionUnavailable) return "transcription";
  return "backend";
}

/** Unknown native outcomes stay open in the wire view. */
function knownRequestFailure(cause: RequestFailure) {
  const provider = providerFailure(cause);
  return (
    cause !== "interrupted" &&
    cause !== "history" &&
    cause !== "backend" &&
    !(provider?.kind === "network" && provider.ran)
  );
}

/** Slack rules: bot/app/workspace namespace and Slack message timestamps. */
export function slackTransport(
  config: BotConfig,
  identity: Identity,
): GatewayTransport {
  return {
    name: "slack",
    key: botKey(config, identity),
    allowed: (user, channel) =>
      isAllowedUser(config, user) && isAllowedChannel(config, channel),
    source(job) {
      if (job.slackReaction)
        return {
          channel: job.channel,
          thread: job.thread,
          message: job.slackReaction.ts,
          user: job.user,
          reaction: job.slackReaction,
        };
      const message = job.eventId.slice(job.channel.length + 1);
      if (
        !job.eventId.startsWith(`${job.channel}:`) ||
        !/^\d{1,16}\.\d{1,6}$/.test(message)
      )
        return;
      return {
        channel: job.channel,
        thread: job.thread,
        message,
        user: job.user,
        ...(job.sender === "captain" ? { sender: "captain" as const } : {}),
      };
    },
    note: (job) =>
      job.sender === "captain" ? peerPrefix(job.user) : undefined,
  };
}

export class Gateway {
  private followUpTask: Promise<void> | undefined;
  private slackAdmissionTail = Promise.resolve();
  private readonly meta: MetaCommands;
  private readonly activity: ActivityDelivery;
  private readonly cancellations = new Map<number, AbortController>();
  /** Conversations needing catch-up, with read-retry backoff state. */
  private readonly settled = new Map<
    string,
    { attempts: number; at: number }
  >();
  /** Deleted sessions or lost cursors: no background probes until a request. */
  private readonly unavailable = new Set<string>();
  /** Slack intake, controls and thread context; absent for other transports. */
  private bot: BotConfig | undefined;
  private transport: GatewayTransport;
  private paused = false;
  private active = 0;
  private notificationFault = false;
  private mutedAdmissions = 0;
  /** Every job a worker holds, with the transport rules of its start. */
  private readonly turnPolicies = new Map<number, GatewayTransport>();
  readonly key: string;
  private questions: Questions | undefined;
  private readonly supportsQuestions: boolean;
  private readonly slackQuestions: SlackQuestionControls | undefined;
  private readonly questionLifetime = new AbortController();
  constructor(
    private config: GatewayConfig,
    private readonly identity: Identity,
    private readonly store: Store,
    private readonly backend: AgentBackend,
    private readonly slack: TransportDelivery,
    private readonly log: Logger,
    /** Present only when the bot configures transcription. */
    private transcriber?: Transcriber,
    /** Slack user directory for peer captain checks. */
    private readonly peers?: PeerDirectory,
    /** Defaults to Slack rules for a Slack `BotConfig`. */
    transport?: GatewayTransport,
    /** Separate Slack preferences, never a reply-delivery access rule. */
    private readonly notifications?: NotificationReader,
    metaOptions?: MetaOptions,
    private readonly updateNotice?: (
      sessionID: string,
      signal: AbortSignal,
    ) => Promise<void>,
    /** Host-wide maintenance drain: holds new turns, never running work. */
    private readonly drain?: DrainControl,
  ) {
    this.meta = new MetaCommands(store, slack, metaOptions);
    drain?.attach({
      broadcast: (record, signal) => this.broadcastDrain(record, signal),
      ...(backend.resumeMaintenance
        ? {
            resume: (signal) =>
              backend.resumeMaintenance?.(signal) ??
              Promise.resolve({ remaining: 0 }),
          }
        : {}),
    });
    this.bot = "slack" in config ? config : undefined;
    const selected =
      transport ?? (this.bot ? slackTransport(this.bot, identity) : undefined);
    if (!selected) throw new Error("Gateway transport is required");
    this.transport = selected;
    this.key = selected.key;
    if (this.bot && config.backend.type === "opencode") {
      this.slackQuestions = new SlackQuestionControls(
        store,
        slack,
        () => this.bot,
        identity,
        async (user) => (await metaOptions?.isHuman?.(user)) === true,
        async () =>
          this.bot
            ? resolveQuestionSettings(this.bot)
            : {
                enabled: false,
                timeoutMs: 900_000,
                answer: "requester" as const,
              },
        async (job, token, answer, user) => {
          await this.answerQuestion(
            { ...job, user },
            { target: identity.user, token, answer },
          );
        },
      );
    }
    this.supportsQuestions = !!(
      backend.pendingQuestions &&
      backend.questionState &&
      backend.questionBelongsToInput &&
      backend.replyQuestion &&
      backend.questionInputSettled
    );
    this.enableQuestions();
    this.activity = new ActivityDelivery(
      backend,
      slack,
      () => this.config.crewActivity,
      (job) =>
        !job.deferDelivery &&
        (this.turnPolicies.get(job.id) ?? this.transport).allowed(
          job.user,
          job.channel,
          job,
        ) &&
        this.allowed(job),
      log,
      { store },
    );
  }

  private enableQuestions() {
    if (
      !this.questions &&
      this.supportsQuestions &&
      (this.transport.questions || this.slackQuestions)
    )
      this.questions = new Questions(
        this.key,
        this.store,
        this.backend,
        () => this.questionPort(),
        (job) => this.allowed(job),
        (session) => this.settle(session),
        this.questionLifetime.signal,
      );
  }

  private questionPort(): QuestionPort | undefined {
    if (!this.slackQuestions || !this.bot) return this.transport.questions;
    const bot = this.bot;
    const ui = this.slackQuestions;
    return {
      account: this.identity.user,
      human: (user) =>
        /^[UW][A-Z0-9]+$/.test(user) &&
        user !== this.identity.user &&
        user !== "USLACKBOT",
      authorized: (job) => this.allowed(job),
      settings: () => resolveQuestionSettings(bot),
      answerAllowed: async (user, job) => this.allowed({ ...job, user }),
      publishQuestion: (job, offer, question, allowed) =>
        ui.publishQuestion(job, offer, question, allowed),
      publish: async (job, text, allowed) => {
        if (!allowed()) return;
        await this.slack.post(job.channel, job.thread, text, undefined, {
          allowed,
        });
      },
    };
  }

  /** Replace future-turn settings; existing turns hold immutable references. */
  reconfigure(
    config: GatewayConfig,
    transcriber?: Transcriber,
    transport?: GatewayTransport,
  ) {
    const bot = "slack" in config ? config : undefined;
    const selected =
      transport ?? (bot ? slackTransport(bot, this.identity) : this.transport);
    if (selected.key !== this.key)
      throw new Error("restart required: gateway namespace");
    this.config = config;
    this.bot = bot;
    this.transcriber = transcriber;
    this.transport = selected;
    // An IRC policy reload can enrol or remove the last human. Keep any
    // existing bridge for settlement, while its port reads current authority.
    this.enableQuestions();
  }

  /** Stop taking new slots while an idle roster member is detached. */
  pause(value = true) {
    this.paused = value;
  }

  /**
   * Passive maintenance notice: the backend queues pin and crew contexts; each
   * mapped, unpinned session is queued through the same validated API. A
   * session that no longer validates is skipped, not reported as uncertain.
   */
  private async broadcastDrain(
    record: MaintenanceDrain,
    signal: AbortSignal,
  ): Promise<UpdateReceipt[]> {
    const receipts = [
      ...((await this.backend.maintenanceNotice?.(record, signal)) ?? []),
    ];
    if (!this.backend.queueUpdateNotice || this.backend.sessionID)
      return receipts;
    const phase = drainNoticePhase(record);
    const text = drainNoticeText(record);
    const sessions = new Set<string>();
    for (const conversation of this.store.transcripts(this.key)) {
      const session = this.store.session(conversation);
      if (session) sessions.add(session);
    }
    for (const sessionID of [...sessions].slice(0, 200)) {
      signal.throwIfAborted();
      try {
        await this.backend.queueUpdateNotice(
          sessionID,
          drainNoticeID(record.runID, phase, sessionID),
          text,
          signal,
        );
        receipts.push({ sessionID, status: "queued" });
      } catch {
        signal.throwIfAborted();
        this.log.warn(
          "Maintenance notice skipped a session that no longer validates",
        );
      }
    }
    return receipts;
  }

  isIdle() {
    const counts = this.store.queueCounts(this.key);
    return (
      this.active === 0 &&
      this.settled.size === 0 &&
      counts.queued + counts.running + counts.responding === 0
    );
  }

  /** Classify one whole reply once; chunks carry their own content. */
  private prepare(text: string, unbounded = false): ReplyChunk[] {
    return (
      this.slack.prepareReply?.(text, unbounded) ??
      (unbounded ? transcriptChunks(text) : chunks(text))
    );
  }

  private allowed(job: GatewayAccessContext) {
    return (
      !(
        this.bot &&
        job.sender === "captain" &&
        !this.bot.access.peerCaptains
      ) && this.transport.allowed(job.user, job.channel, job)
    );
  }

  accept(body: unknown, peer?: PeerSender, resumesThread = false) {
    if (metaCandidate(body, this.identity)) return false;
    const bot = this.bot;
    if (!bot) return false;
    const routed = this.route(body, peer);
    if (!routed) return false;
    const followed = resumesThread || this.store.follows(routed.conversation);
    // A voice message in a thread the bot follows keeps today's behaviour,
    // unless every turn needs a mention.
    const held = "gate" in routed && routed.gate === "spoken";
    const input: Incoming & { startsConversation: boolean } =
      held && followed && !bot.access.mentionOnly
        ? { ...routed, gate: null }
        : routed;
    if (!input.startsConversation && !followed && input.gate !== "spoken")
      return false;
    // Loop protection: a peer captain gets a bounded number of turns per
    // thread. The window ends at this message's Slack time, not host time.
    const sent = Number(input.eventId.slice(input.channel.length + 1)) * 1000;
    if (
      input.sender === "captain" &&
      (!Number.isFinite(sent) ||
        this.store.peerTurns(input.conversation, sent - peerWindowMs) >=
          (bot.access.peerTurnsPerHour ?? peerTurnsPerHour))
    ) {
      this.log.warn("Peer captain thread limit reached; message not admitted");
      return false;
    }
    return this.admitChat(input, bot);
  }

  private admitChat(input: Incoming, bot: BotConfig) {
    const accepted =
      (bot.slack.steerThreadFollowUps && this.backend.sessionID
        ? this.store.admitFollowUp(input, this.backend.sessionID)
        : undefined) ?? this.store.enqueue(input);
    if (
      accepted &&
      this.slackQuestions &&
      !input.sender &&
      !input.fleet &&
      !input.slackReaction
    )
      this.store.questions.recordQuestionSource(input);
    return accepted;
  }

  /** Existing worker poll drains durable intake; no new turn or scheduler. */
  async pollFollowUps(signal: AbortSignal, finalOwner?: number): Promise<void> {
    if (this.followUpTask !== undefined) return this.followUpTask;
    this.followUpTask = this.deliverFollowUps(signal, finalOwner);
    try {
      await this.followUpTask;
    } finally {
      this.followUpTask = undefined;
    }
  }

  private async deliverFollowUps(signal: AbortSignal, finalOwner?: number) {
    for (const receipt of this.store.followUps(this.key, finalOwner)) {
      signal.throwIfAborted();
      const input = this.store.followUpInput(receipt);
      let state = receipt.state;
      const owner = this.store.jobByInput(this.key, receipt.inputID);
      const source = owner ? this.transport.source(input) : undefined;
      const allowed = () =>
        !this.drain?.held() &&
        this.allowed(input) &&
        this.reactionNotificationsOpen(input) &&
        this.backend.sessionID === receipt.sessionID &&
        (this.bot
          ? this.bot.slack.steerThreadFollowUps
          : "steerThreadFollowUps" in this.config &&
            this.config.steerThreadFollowUps) === true &&
        this.store.ownsFollowUp(receipt);
      const native: SteerInput | undefined = source
        ? {
            sessionID: receipt.sessionID,
            inputID: receipt.inputID,
            id: receipt.nativeID,
            text: input.text,
            context: { source },
            allowed,
          }
        : undefined;
      if (state === "pending" && this.store.claimFollowUp(receipt)) {
        let result: SteerResult = { status: "refused" };
        if (native && allowed() && this.backend.steer) {
          try {
            result = await this.backend.steer(
              native,
              AbortSignal.any([signal, AbortSignal.timeout(1800)]),
            );
          } catch {
            result = { status: "uncertain" };
          }
        }
        state = result.status === "refused" ? "queued" : result.status;
        this.store.settleFollowUp(receipt, state);
      } else if (
        (state === "writing" || state === "uncertain") &&
        (finalOwner === receipt.owner ||
          (receipt.reconcileAttempts < 8 && receipt.retryAt <= Date.now()))
      ) {
        // A crash may have followed the write. Read evidence only; never replay.
        let result: SteerResult = { status: "uncertain" };
        if (native && this.backend.reconcileSteer) {
          try {
            result = await this.backend.reconcileSteer(
              native,
              AbortSignal.any([signal, AbortSignal.timeout(1800)]),
            );
          } catch {
            /* Ambiguous native evidence remains held. */
          }
        }
        state = result.status === "accepted" ? "accepted" : "uncertain";
        this.store.settleFollowUp(receipt, state);
      }
      if ((receipt.notified && state === receipt.state) || !this.allowed(input))
        continue;
      if (!this.reactionNotificationsOpen(input)) {
        const queued =
          state === "queued" &&
          this.store.jobByEvent(input.botKey, input.eventId);
        if (queued) this.notificationDispatch(queued);
        this.store.notifiedFollowUp(receipt);
        continue;
      }
      try {
        if (state === "accepted") {
          if (!input.slackReaction) {
            const message = input.eventId.slice(input.channel.length + 1);
            await this.slack.react?.(input.channel, message, "eyes", () =>
              this.allowed(input),
            );
          }
        } else if (state === "queued" || state === "uncertain") {
          await this.slack.post(
            input.channel,
            input.thread,
            state === "uncertain"
              ? "Follow-up delivery is unconfirmed. It has not been queued or repeated."
              : receipt.state === "queued"
                ? "Queued behind another request."
                : "Could not steer the running request; queued as the next request.",
            undefined,
            { allowed: () => this.allowed(input) },
          );
        }
        this.store.notifiedFollowUp(receipt);
      } catch {
        this.log.warn("Follow-up notification unavailable");
      }
    }
  }

  private route(body: unknown, peer?: PeerSender) {
    const bot = this.bot;
    if (!bot) return;
    return this.routeNotifications((read) =>
      routeEvent(body, bot, this.identity, peer, read),
    );
  }

  private routeNotifications<T>(route: (read?: NotificationReader) => T) {
    let muted = false;
    try {
      const routed = route(
        this.notifications
          ? (channel, thread) => {
              const state = this.notifications?.(channel, thread);
              if (!state) throw new Error("Notification reader unavailable");
              this.notificationFault = false;
              muted = state.mode === "addressed-only";
              return state;
            }
          : undefined,
      );
      if (!routed && muted) {
        this.mutedAdmissions = Math.min(
          Number.MAX_SAFE_INTEGER,
          this.mutedAdmissions + 1,
        );
        // Bounded counters, no persistent row or message body for ignored traffic.
        if (
          this.mutedAdmissions === 1 ||
          Number.isInteger(Math.log2(this.mutedAdmissions))
        )
          this.log.debug(
            { count: this.mutedAdmissions },
            "Muted Slack notification not admitted",
          );
      }
      return routed;
    } catch {
      this.notificationUnavailable();
      // Transient preference faults must not ACK and lose the live event.
      throw new Error("Notification preferences unavailable; retry admission.");
    }
  }

  private reactionNotificationsOpen(input: Incoming) {
    if (!input.slackReaction || !input.notification || !this.notifications)
      return true;
    try {
      const state = this.notifications(input.channel, input.thread);
      this.notificationFault = false;
      return state.mode === "normal";
    } catch {
      this.notificationUnavailable();
      return false;
    }
  }

  private notificationUnavailable() {
    if (!this.notificationFault)
      this.log.warn(
        "Notification preferences unavailable; Slack chat admission held",
      );
    this.notificationFault = true;
  }

  private notificationDispatch(job: Job): Job | undefined {
    if (
      job.status !== "queued" ||
      !job.notification ||
      !this.notifications ||
      job.channel.startsWith("D")
    )
      return job;
    try {
      const state = this.notifications(job.channel, job.thread);
      this.notificationFault = false;
      if (
        state.mode === "addressed-only" &&
        job.notification.wake === "ordinary"
      ) {
        if (!this.store.suppressNotification(job.id)) this.refused(job, "mute");
        return;
      }
      return {
        ...job,
        notification: {
          wake: job.notification.wake,
          ...(state.mode === "addressed-only" &&
          job.notification.wake !== "ordinary"
            ? {
                note: notificationNote(
                  job.channel,
                  job.thread,
                  job.notification.wake,
                  state,
                ),
              }
            : {}),
        },
      };
    } catch {
      this.notificationUnavailable();
      // Keep the queued row; neither fail open nor turn a storage fault into a mute.
      this.store.holdNotification(job.id, Date.now() + 5000);
      return;
    }
  }

  /** Configuration buttons share the typed-command owner and intake binding. */
  async configInteraction(
    body: unknown,
    ack: SocketRequest["ack"],
    open: () => boolean = () => true,
  ) {
    const bot = this.bot;
    if (!bot) return false;
    if (
      await this.slackQuestions?.interactive(
        body,
        ack,
        () => open() && this.bot === bot,
      )
    )
      return true;
    return this.meta.interactive(
      body,
      bot,
      this.identity,
      () => open() && this.bot === bot,
      ack,
    );
  }

  /**
   * Slack intake. A bot message is admitted only after Slack's directory
   * proves a peer captain; a failed or slow lookup admits nothing. `open` is
   * checked again after the lookup, before anything is stored.
   */
  async receive(body: unknown, open: () => boolean = () => true) {
    const bot = this.bot;
    if (!bot || !open()) return false;
    const current = () => open() && this.bot === bot;
    const reaction = routeReaction(body, bot, this.identity);
    if (reaction)
      return this.orderSlackAdmission(current, (admit) =>
        this.receiveReaction(reaction, bot, current, admit),
      );
    const question = this.slackQuestions?.receive(body, current);
    if (question && (await question)) return false;
    const meta = this.meta.receive(body, bot, this.identity, current);
    if (meta !== false) {
      await meta;
      return false;
    }
    return bot.slack.inboundReactions
      ? this.orderSlackAdmission(current, (admit) =>
          this.receiveMessage(body, bot, current, admit),
        )
      : this.receiveMessage(body, bot, open);
  }

  /** Start lookups on arrival; only the durable writes wait their turn. */
  private async orderSlackAdmission(
    open: () => boolean,
    receive: (admit: SlackAdmission) => Promise<boolean>,
  ) {
    const before = this.slackAdmissionTail;
    const slot = Promise.withResolvers<void>();
    this.slackAdmissionTail = slot.promise;
    try {
      return await receive(async (write) => {
        await before;
        return open() && write();
      });
    } finally {
      // A rejected event must not let a later event pass an earlier lookup.
      await before;
      slot.resolve();
    }
  }

  private async receiveMessage(
    body: unknown,
    bot: BotConfig,
    open: () => boolean,
    admit: SlackAdmission = (write) => write(),
  ) {
    const sender = botSender(body);
    if (sender && bot.access.peerCaptains && this.peers) {
      const verified = await this.peers
        .verify(sender, AbortSignal.timeout(peerLookupMs))
        .catch(() => false);
      if (!open()) return false;
      return admit(() => this.accept(body, verified ? sender : undefined));
    }
    if (bot.resumeSlackThreads && this.slack.threadContext && !sender) {
      const input = this.route(body);
      if (!input) return false;
      const before = input.eventId.slice(input.channel.length + 1);
      if (
        before !== input.thread &&
        !input.startsConversation &&
        !input.gate &&
        !this.store.follows(input.conversation)
      ) {
        // No ACK on a transient lookup failure: Slack can redeliver.
        const history = await this.slack.threadContext({
          channel: input.channel,
          thread: input.thread,
          before,
          user: input.user,
          botUser: this.identity.user,
          appId: bot.slack.appId,
          team: this.identity.team,
          signal: AbortSignal.timeout(1800),
        });
        if (!open() || this.bot !== bot) return false;
        return admit(() =>
          this.accept(
            body,
            undefined,
            history.messages.some((message) => message.author === "this_bot"),
          ),
        );
      }
    }
    return admit(() => this.accept(body));
  }

  private async receiveReaction(
    input: NonNullable<ReturnType<typeof routeReaction>>,
    bot: BotConfig,
    open: () => boolean,
    admit: SlackAdmission,
  ) {
    const {
      channel,
      user,
      slackReaction: { ts, name, action },
    } = input;
    let thread = this.store.slackReplyThread(this.key, channel, ts);
    if (!this.slack.userInfo || (!thread && !this.slack.reactionThread))
      return false;
    // Both reads share the Socket Mode acknowledgement budget.
    const signal = AbortSignal.any([
      this.questionLifetime.signal,
      AbortSignal.timeout(2200),
    ]);
    try {
      if (!isSlackHuman(await this.slack.userInfo(user, signal), user))
        return false;
      if (signal.aborted || !open()) return false;
      thread ??= await this.slack.reactionThread?.({
        channel,
        ts,
        appId: bot.slack.appId,
        identity: this.identity,
        signal,
      });
    } catch {
      return false;
    }
    if (!thread || signal.aborted) return false;
    const root = thread;
    return admit(() => {
      if (!this.allowed(input)) return false;
      const admission = this.routeNotifications((read) => {
        const notification = channel.startsWith("D")
          ? undefined
          : read?.(channel, root);
        if (notification?.mode === "addressed-only") return;
        return {
          ...input,
          conversation: conversationKey(this.key, channel, root),
          thread: root,
          text: `Slack reaction :${name}: ${action}.`,
          ...(notification
            ? { notification: { wake: "ordinary" as const } }
            : {}),
        };
      });
      return admission ? this.admitChat(admission, bot) : false;
    });
  }

  /** Commit the exact requester-authorized target before Socket Mode ACK. */
  cancel(body: unknown) {
    if (!this.bot) return false;
    const target = cancellationTarget(body, this.bot, this.identity);
    if (!target || !this.store.cancel(this.key, target)) return false;
    this.cancellations.get(target.id)?.abort();
    return true;
  }

  /**
   * Transport Stop (IRC reaction): cancel the active turn for one request in
   * one conversation, exactly like an accepted Slack Stop. The transport
   * has already checked who may stop it.
   */
  stopTurn(conversation: string, thread: string) {
    const id = this.store.cancelTurn(this.key, conversation, thread);
    if (id === undefined) return false;
    const active = this.cancellations.get(id);
    if (active) active.abort();
    else
      void this.questions
        ?.stop(
          id,
          AbortSignal.any([
            this.questionLifetime.signal,
            AbortSignal.timeout(5000),
          ]),
        )
        .catch(() =>
          this.log.warn(
            "Recovered native Stop outcome unavailable; not replayed",
          ),
        );
    return true;
  }

  /** Only transport-verified controls reach this method; they never enter a model. */
  async answerQuestion(
    input: Incoming,
    control: NonNullable<ReturnType<typeof questionControl>>,
  ) {
    if (this.questionLifetime.signal.aborted) return;
    await this.questions?.answer(
      input,
      control,
      AbortSignal.any([
        this.questionLifetime.signal,
        AbortSignal.timeout(10_000),
      ]),
    );
  }

  async operatorQuestion(
    actor: string,
    text: string,
    connected: () => boolean,
  ) {
    await this.questions?.operatorAnswer(
      actor,
      text,
      AbortSignal.any([
        this.questionLifetime.signal,
        AbortSignal.timeout(/^show /i.test(text.trim()) ? 60_000 : 10_000),
      ]),
      connected,
    );
  }

  async pollQuestions(signal: AbortSignal) {
    await this.questions?.poll(signal);
  }

  enqueueScheduled(input: {
    runId: string;
    channel: string;
    user: string;
    prompt: string;
    thread: string;
    name: string;
    deferDelivery?: boolean;
  }): number | undefined {
    if (!this.allowed(input)) return;
    const eventId = input.deferDelivery
      ? `scheduled:${input.runId}`
      : `${input.channel}:${input.thread}`;
    this.store.enqueue({
      eventId,
      botKey: this.key,
      conversation: input.deferDelivery
        ? JSON.stringify([this.key, input.channel, "scheduled", input.runId])
        : conversationKey(this.key, input.channel, input.thread),
      channel: input.channel,
      thread: input.thread,
      user: input.user,
      text: input.prompt,
      deferDelivery: input.deferDelivery ?? false,
    });
    return this.store.queuedJob(this.key, eventId)?.id;
  }

  scheduledStatus(jobId: number) {
    return this.store.jobStatus(this.key, jobId);
  }

  /** At most 12,000 characters of durable public output; never starts work. */
  scheduledResult(jobId: number):
    | {
        text: string;
        status: JobStatus;
        failure?: RequestFailure | null;
      }
    | undefined {
    return this.store.scheduledResult(this.key, jobId);
  }

  /**
   * Supervise this bot until the signal aborts. One scope owns the per-
   * conversation slots, the transcript watch and activity reporting. A failed
   * poll closes that scope, stops the watch and rejects, so the runtime can
   * restart Stargate instead of leaving a silent, half-stopped worker.
   */
  async work(signal: AbortSignal) {
    const stopQuestions = () => this.questionLifetime.abort();
    signal.addEventListener("abort", stopQuestions, { once: true });
    try {
      await runAbortable(this.supervise(), signal).catch((error: unknown) => {
        if (!signal.aborted) throw error;
      });
    } finally {
      stopQuestions();
      signal.removeEventListener("abort", stopQuestions);
    }
  }

  private supervise() {
    const gateway = this;
    return Effect.scoped(
      Effect.gen(function* () {
        yield* abortable((signal) => gateway.recover(signal));
        if (
          gateway.questions ||
          (gateway.transport.name === "irc" && gateway.supportsQuestions)
        )
          yield* Effect.forkScoped(
            abortable(async (signal) => {
              while (!signal.aborted) {
                try {
                  await gateway.questions?.poll(
                    AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
                  );
                } catch {
                  if (!signal.aborted)
                    gateway.log.warn("Native clarification check unavailable");
                }
                await delay(1000, undefined, { signal }).catch(() => {});
              }
            }),
          );
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => gateway.activity.close()),
        );
        const watch = gateway.backend.transcript && gateway.backend.watch;
        if (watch)
          yield* Effect.forkScoped(
            abortable((signal) =>
              watch.call(
                gateway.backend,
                (session) => gateway.settle(session),
                signal,
                gateway.transport.questions?.operator
                  ? () => gateway.questions?.reconcileBackground()
                  : undefined,
              ),
            ).pipe(
              Effect.catchCause(() =>
                Effect.sync(() => gateway.log.warn("Transcript watch stopped")),
              ),
            ),
          );
        // Closes first: every turn and catch-up observes shutdown and settles.
        const slots = yield* FiberMap.make<string>();
        yield* Effect.repeat(
          gateway.poll(slots),
          Schedule.spaced("200 millis"),
        );
      }),
    );
  }

  /** Stop surviving backend work before a fresh turn can resume it. */
  private async recover(signal: AbortSignal) {
    let retainedQuestions: string[] = [];
    try {
      retainedQuestions =
        (await this.questions?.recover(
          AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        )) ?? [];
    } catch {
      this.log.warn(
        "Native clarification recovery unavailable; native work left untouched",
      );
      // A later offer's failed read must not discard already-verified holds.
      // Abort startup before ordinary recovery can interrupt/reset any input.
      throw new Error("Native clarification recovery unavailable");
    }
    const retainedSessions = new Set(
      retainedQuestions.map((input) => {
        const job = this.store.jobByInput(this.key, input);
        return job ? this.store.session(job.conversation) : undefined;
      }),
    );
    const interrupted = this.backend.sessionID
      ? []
      : this.store.interruptedSessions(this.key);
    if (this.backend.sessionID) {
      const input = this.store.interruptedInput(this.key);
      if (
        input &&
        !retainedQuestions.includes(input) &&
        this.backend.interruptInput
      ) {
        try {
          await this.backend.interruptInput(
            this.backend.sessionID,
            input,
            AbortSignal.timeout(5000),
          );
        } catch {
          this.log.warn(
            "Interrupted captain ownership unavailable; not stopping native work",
          );
        }
      }
    }
    for (const session of interrupted) {
      if (retainedSessions.has(session)) continue;
      await this.backend.interrupt?.(session, AbortSignal.timeout(5000));
    }
    this.store.recover(this.key, retainedQuestions);
    // Restart catch-up for every mapping; unbaselined ones seed at current history.
    if (this.backend.transcript) this.settle();
    if (this.backend.sessionID) {
      const job = this.store.latestBotActivity(this.key);
      if (job) await this.activity.resume(job, this.backend.sessionID, signal);
      return;
    }
    for (const conversation of this.store.transcripts(this.key)) {
      const job = this.store.latestActivity(this.key, conversation);
      const session = this.store.session(conversation);
      if (job && session) await this.activity.resume(job, session, signal);
    }
  }

  /** One pass: queued requests first, then catch-ups, in shared slots. */
  private poll(slots: FiberMap.FiberMap<string>) {
    const gateway = this;
    return Effect.gen(function* () {
      gateway.drain?.tick();
      if (gateway.paused) return;
      yield* abortable((signal) => gateway.pollFollowUps(signal));
      const used = yield* FiberMap.size(slots);
      // Held: accepted jobs stay queued; responding deliveries may finish.
      const hold = gateway.drain?.held() ?? false;
      const jobs = gateway.store
        .ready(
          gateway.key,
          Date.now(),
          gateway.config.concurrency + used,
          gateway.backend.sessionID !== undefined,
          hold,
        )
        .filter((job) => !hold || job.status !== "queued");
      for (const job of jobs) {
        if ((yield* FiberMap.size(slots)) >= gateway.config.concurrency) break;
        // One worker per job. A pinned turn holds the bot slot while it
        // delivers; its `responding` row must not start again in the
        // conversation slot, or every chunk and file is sent twice.
        if (gateway.turnPolicies.has(job.id)) continue;
        const slot =
          gateway.backend.sessionID && job.status === "queued"
            ? gateway.key
            : job.conversation;
        if (yield* FiberMap.has(slots, slot)) continue;
        yield* FiberMap.run(
          slots,
          slot,
          abortable((signal) => gateway.process(job, signal)).pipe(
            Effect.catchCause(() =>
              Effect.sync(() =>
                gateway.log.error(
                  { job: job.id },
                  "Worker failed; request will need recovery",
                ),
              ),
            ),
          ),
          { startImmediately: true },
        );
      }
      yield* gateway.startCatchUps(slots);
    });
  }

  /** Queue catch-up for a settled session, or every mapped thread on connect. */
  settle(session?: string) {
    if (this.backend.sessionID) {
      if (
        (!session || session === this.backend.sessionID) &&
        !this.unavailable.has(this.key)
      )
        this.queueTranscript(this.key);
      return;
    }
    for (const conversation of this.store.transcripts(this.key, session))
      if (!this.unavailable.has(conversation))
        this.queueTranscript(conversation);
  }

  /** Catch-up state has one key per pinned session, else per conversation. */
  private catchUpKey(conversation: string) {
    return this.backend.sessionID ? this.key : conversation;
  }

  /** New work is eligible now; failed reads keep their backoff count. */
  private queueTranscript(conversation: string) {
    const attempts = this.settled.get(conversation)?.attempts ?? 0;
    this.settled.set(conversation, { attempts, at: 0 });
  }

  /** Start eligible catch-ups; resolves when they end. Public for tests. */
  async catchUp(signal: AbortSignal) {
    const gateway = this;
    await runAbortable(
      Effect.scoped(
        Effect.gen(function* () {
          const slots = yield* FiberMap.make<string>();
          yield* gateway.startCatchUps(slots);
          yield* FiberMap.awaitEmpty(slots);
        }),
      ),
      signal,
    ).catch((error: unknown) => {
      if (!signal.aborted) throw error;
    });
  }

  private startCatchUps(slots: FiberMap.FiberMap<string>) {
    const gateway = this;
    return Effect.gen(function* () {
      if (gateway.paused || gateway.drain?.held()) return;
      const now = Date.now();
      for (const [conversation, retry] of gateway.settled) {
        if ((yield* FiberMap.size(slots)) >= gateway.config.concurrency) break;
        // A pending turn reads the same history; later replies wait for delivery.
        if (
          retry.at > now ||
          (yield* FiberMap.has(slots, conversation)) ||
          (gateway.backend.sessionID
            ? gateway.store.captainBusy(gateway.key)
            : gateway.store.unfinished(conversation))
        )
          continue;
        gateway.settled.delete(conversation);
        yield* FiberMap.run(
          slots,
          conversation,
          abortable((signal) =>
            gateway.catchUpThread(conversation, retry, signal),
          ),
          { startImmediately: true },
        );
      }
    });
  }

  /** Read failures keep the cursor and back off; they never prompt the agent. */
  private async catchUpThread(
    conversation: string,
    retry: { attempts: number },
    signal: AbortSignal,
  ) {
    this.active++;
    try {
      if (!(await this.transcriptCatchUp(conversation, signal)))
        this.queueTranscript(conversation);
    } catch (error) {
      if (signal.aborted) return;
      const awaitingInput =
        error instanceof TranscriptUnavailable &&
        error.reason === "cursor" &&
        this.backend.sessionID &&
        this.store.jobByInput(
          this.key,
          this.store.captainCursor(this.key, this.backend.sessionID).cursor ??
            "",
        ) !== null;
      if (error instanceof TranscriptUnavailable && !awaitingInput) {
        // Keep the mapping and cursor; the next request re-anchors.
        if (!this.unavailable.has(conversation))
          this.log.warn("Transcript unavailable; background catch-up stopped");
        this.unavailable.add(conversation);
        return;
      }
      if (!retry.attempts)
        this.log.warn("Transcript catch-up failed; retrying with backoff");
      // The cursor stays put, so a later read resumes without a gap.
      this.settled.set(conversation, {
        attempts: retry.attempts + 1,
        at: Date.now() + Math.min(retryCeilingMs, 1000 * 2 ** retry.attempts),
      });
    } finally {
      this.active--;
    }
  }

  /** False means another writer changed the thread; read it again. */
  private async transcriptCatchUp(conversation: string, shutdown: AbortSignal) {
    if (this.backend.sessionID)
      return this.captainCatchUp(this.backend.sessionID, shutdown);
    const target = this.store.transcriptTarget(this.key, conversation);
    if (!target || !this.backend.transcript || !this.allowed(target))
      return true;
    const signal = AbortSignal.any([
      shutdown,
      AbortSignal.timeout(catchUpReadMs),
    ]);
    const activityJob = this.store.latestActivity(this.key, conversation);
    if (activityJob)
      await this.activity.resume(activityJob, target.session, shutdown);
    const read = await this.backend.transcript(
      target.session,
      target.cursor,
      signal,
    );
    if (target.cursor === undefined) {
      this.store.baselineTranscript(conversation, read.cursor);
      return true;
    }
    if (read.cursor === target.cursor) return true;
    const text = transcriptReply(read.entries);
    const files = transcriptAttachments(read.entries);
    const last = read.entries.at(-1);
    return (
      this.store.appendTranscript({
        botKey: this.key,
        conversation,
        from: target.cursor,
        cursor: read.cursor,
        replies:
          text && last
            ? [
                {
                  eventId: `transcript:${last.id}`,
                  chunks: this.prepare(text, true),
                  files,
                },
              ]
            : [],
      }) !== undefined
    );
  }

  private followUpAnswer(owner: number, text: string): string {
    const links = this.store.followUpLinks(owner);
    return links && text.trim()
      ? `${text}\n\nFollow-ups included:\n${links}`
      : text;
  }

  /** Resolve native input boundaries, never the latest queued Slack source. */
  private captainTranscript(
    sessionID: string,
    from: CaptainCursor,
    read: FinalTranscript,
    current?: number,
  ): {
    commit: CaptainTranscript;
    text: string;
    files: PublishedFile[];
    silent: boolean;
  } {
    let owner = read.anchored && current !== undefined ? current : from.owner;
    const groups: { job: number; entries: TranscriptEntry[] }[] = [];
    const ownerFor = (input: string) =>
      this.store.jobByInput(this.key, input)?.id ?? null;
    for (const entry of read.entries) {
      if (entry.input !== undefined) owner = ownerFor(entry.input);
      if (owner === null) continue;
      const group = groups.at(-1);
      if (group?.job === owner) group.entries.push(entry);
      else groups.push({ job: owner, entries: [entry] });
    }
    // A native input with no public reply must still clear/set ownership.
    if (read.input !== undefined) owner = ownerFor(read.input);
    const own = groups
      .filter((group) => group.job === current)
      .flatMap((group) => group.entries);
    return {
      text: transcriptReply(own),
      files: transcriptAttachments(own),
      silent: transcriptSilent(own),
      commit: {
        botKey: this.key,
        sessionID,
        from,
        cursor: read.cursor,
        owner,
        replies: groups.flatMap((group) => {
          const text = transcriptReply(group.entries);
          const last = group.entries.at(-1);
          return group.job !== current && text && last
            ? [
                {
                  job: group.job,
                  eventId: `transcript:${last.id}`,
                  chunks: this.prepare(
                    this.followUpAnswer(group.job, text),
                    true,
                  ),
                  files: transcriptAttachments(group.entries),
                },
              ]
            : [];
        }),
      },
    };
  }

  private async captainCatchUp(sessionID: string, shutdown: AbortSignal) {
    if (!this.backend.transcript) return true;
    const from = this.store.captainCursor(this.key, sessionID);
    const signal = AbortSignal.any([
      shutdown,
      AbortSignal.timeout(catchUpReadMs),
    ]);
    const validated = await this.backend.createSession({
      key: this.key,
      title: botDisplayName(this.config),
      signal,
    });
    if (validated !== sessionID)
      throw new Error("Pinned session identity changed");
    const activity = this.store.latestBotActivity(this.key);
    if (activity) await this.activity.resume(activity, sessionID, shutdown);
    const read = await this.backend.transcript(sessionID, from.cursor, signal);
    const { commit } = this.captainTranscript(sessionID, from, read);
    return this.store.appendCaptainTranscript(commit) && !read.pending;
  }

  /** Cursor before this turn; undefined keeps the prompt-only contract. */
  private async transcriptFrom(
    conversation: string,
    session: string,
    signal: AbortSignal,
  ) {
    if (!this.backend.transcript) return;
    const from = this.store.transcriptCursor(conversation);
    if (from !== undefined) return from;
    try {
      const { cursor } = await this.backend.transcript(
        session,
        undefined,
        signal,
      );
      return this.store.baselineTranscript(conversation, cursor);
    } catch (error) {
      if (signal.aborted) throw error;
      // No cursor exists yet, so the prompt reply cannot be delivered twice.
      this.log.warn("Transcript baseline unavailable; using prompt reply");
      return;
    }
  }

  /** Retries briefly for final completion marks; typed loss is not retried. */
  private async settledRead(
    session: string,
    after: string,
    signal: AbortSignal,
  ): Promise<Transcript | TranscriptUnavailable | undefined> {
    let read: Transcript | undefined;
    for (const wait of [0, ...finalReadDelaysMs]) {
      try {
        if (wait) await delay(wait, undefined, { signal });
        read =
          (await this.backend.transcript?.(session, after, signal)) ?? read;
        if (read && !read.pending) return read;
      } catch (error) {
        if (error instanceof TranscriptUnavailable && !read) return error;
        if (signal.aborted) break;
      }
    }
    return read;
  }

  /**
   * Settled history for a finished request. A typed lost cursor, or a legacy
   * mapping without a baseline, re-reads strictly after this request's own
   * native input. Undefined means unreadable: delivery waits for catch-up.
   */
  private async finalTranscript(
    session: string,
    from: string | undefined,
    signal: AbortSignal,
  ): Promise<FinalTranscript | undefined> {
    if (from !== undefined) {
      const read = await this.settledRead(session, from, signal);
      if (read && !(read instanceof TranscriptUnavailable)) return read;
      if (
        !(read instanceof TranscriptUnavailable && read.reason === "cursor")
      ) {
        this.log.warn("Transcript read failed; reply deferred");
        return;
      }
    }
    const anchored = await this.settledRead(session, latestInput, signal);
    if (!anchored || anchored instanceof TranscriptUnavailable) return;
    return {
      ...anchored,
      anchored: true,
      ...(from === undefined ? {} : { gap: true }),
    };
  }

  private transcriptText(read: Transcript & { gap?: true }) {
    return [read.gap ? gapNote : "", transcriptReply(read.entries)]
      .filter(Boolean)
      .join("\n\n");
  }

  /**
   * Transcribe a held voice message and keep it only if its speech names the
   * bot. Otherwise only a content-free row remains: no turn, no post.
   * A failure is treated like no mention, because the speech is unknown.
   * Shutdown leaves the row queued for the next process.
   */
  private async hear(
    job: Job,
    shutdown: AbortSignal,
    snapshot: {
      config: GatewayConfig;
      bot: BotConfig | undefined;
      transcriber: Transcriber | undefined;
    },
  ): Promise<Awaited<ReturnType<typeof transcribeMedia>> | undefined> {
    const mention = snapshot.bot?.transcription?.spokenMentions;
    const timeoutMs = snapshot.bot?.transcription?.timeoutMs ?? 120_000;
    const ignore = (message: string) => {
      this.log.info({ job: job.id }, message);
      this.store.discard(job.id);
      return undefined;
    };
    if (
      !mention?.channels.includes(job.channel) ||
      !snapshot.transcriber ||
      !this.slack.files
    )
      return ignore("Voice message ignored: spoken mentions not configured");
    let heard: Awaited<ReturnType<typeof transcribeMedia>>;
    try {
      const signal = AbortSignal.any([
        shutdown,
        AbortSignal.timeout(snapshot.config.turnTimeoutMs),
      ]);
      const files = await this.slack.files.download(
        this.store.inputFiles(job.id),
        job.channel,
        signal,
      );
      checkAttachments(files);
      if (!files.some(isMedia))
        return ignore("Message without media or mention ignored");
      heard = await transcribeMedia(
        files,
        snapshot.transcriber,
        timeoutMs,
        signal,
      );
    } catch {
      if (shutdown.aborted) return;
      return ignore("Voice message not transcribed; ignored without a reply");
    }
    if (!spokenMention(heard.transcripts, mention.names))
      return ignore("Voice message without spoken mention ignored");
    return this.store.admitSpoken(job.id) ? heard : undefined;
  }

  /** Public for deterministic integration tests and single-step workers. */
  async process(held: Job, shutdown: AbortSignal) {
    const config = this.config;
    const bot = this.bot;
    const transcriber = this.transcriber;
    const transport = this.transport;
    // New allows never expand this turn; new denies stop its next delivery.
    const allowed = (job: GatewayAccessContext) =>
      transport.allowed(job.user, job.channel, job) && this.allowed(job);
    this.active++;
    this.turnPolicies.set(held.id, transport);
    try {
      return await this.processTurn(held, shutdown, {
        config,
        bot,
        transcriber,
        transport,
        allowed,
      });
    } finally {
      this.active--;
      this.turnPolicies.delete(held.id);
    }
  }

  private async processTurn(
    held: Job,
    shutdown: AbortSignal,
    snapshot: {
      config: GatewayConfig;
      bot: BotConfig | undefined;
      transcriber: Transcriber | undefined;
      transport: GatewayTransport;
      allowed: (job: GatewayAccessContext) => boolean;
    },
  ) {
    const { config, bot, transcriber, transport, allowed } = snapshot;
    // Recheck policy for queued inputs and pending delivery after a restart.
    if (!allowed(held)) {
      if (held.gate === "spoken") this.store.discard(held.id);
      else if (!this.store.finish(held.id, "failed"))
        this.refused(held, "finish");
      return;
    }
    const pending = this.notificationDispatch(held);
    if (!pending) return;
    // A transcript held only in this call; a restart transcribes again.
    let heard: Awaited<ReturnType<typeof transcribeMedia>> | undefined;
    if (held.status === "queued" && held.gate === "spoken") {
      heard = await this.hear(held, shutdown, { config, bot, transcriber });
      if (!heard) return;
    }
    const classified =
      held.gate === "spoken" ? this.notificationDispatch(pending) : pending;
    if (!classified) return;
    const job: Job =
      held.gate === "spoken" ? { ...classified, gate: "admitted" } : classified;
    const turnStatus = transport.turnStatus?.(job);
    const request =
      !job.deferDelivery && turnStatus && turnStatus !== "quiet"
        ? transport.progressRequest?.(job)
        : undefined;
    const publishOutcome = (outcome: RequestOutcome) => {
      if (request && !shutdown.aborted)
        void this.slack
          .requestSettled?.(job.channel, request, outcome, shutdown, () =>
            allowed(job),
          )
          .catch(() => {});
    };
    const readReceipt = async (active: boolean) => {
      if (
        bot?.slackReadReceipts &&
        job.received != null &&
        !job.slackReaction &&
        !job.sender &&
        !job.deferDelivery &&
        allowed(job)
      ) {
        const timestamp = job.eventId.slice(job.channel.length + 1);
        await this.slack
          .readReceipt?.(job.channel, timestamp, active)
          .catch(() =>
            this.log.warn({ job: job.id }, "Slack read receipt unavailable"),
          );
      }
    };
    const statusText = (cause: RequestFailure) =>
      job.deferDelivery && cause === "history"
        ? "The agent finished, but its public reply is not yet readable in session history. Stargate will retain it locally when it becomes readable. The request was not repeated."
        : failureText(cause);
    let output: ReplyChunk[];
    let failure = job.failure ?? undefined;
    if (job.status === "queued") {
      // Intake may have extended a queued IRC burst after ready() returned.
      // Refuse a stale snapshot; the next poll reads its full text and files.
      // Re-check at the last moment: a drain can start after ready() returned.
      if (this.drain?.held()) return;
      if (!this.store.running(job.id, job.text)) return;
      await readReceipt(true);
      // Only an accepted requester Stop aborts this controller.
      const cancellation = new AbortController();
      const maintenanceFailure = new AbortController();
      const budget = new TurnBudget(config.turnTimeoutMs);
      this.cancellations.set(job.id, cancellation);
      const signal = AbortSignal.any([
        shutdown,
        cancellation.signal,
        maintenanceFailure.signal,
        budget.controller.signal,
      ]);
      // Ends before delivery, so a typing indicator never outlasts the turn.
      const typing = new AbortController();
      const observeProgress =
        !job.deferDelivery &&
        ((turnStatus === "notice" && config.backend.type === "opencode") ||
          turnStatus === "live");
      let progress: TurnProgress | undefined;
      const working = job.deferDelivery
        ? undefined
        : this.slack
            .working?.(
              job.channel,
              job.thread,
              AbortSignal.any([typing.signal, signal]),
              () => allowed(job),
              turnStatus,
              observeProgress ? () => progress : undefined,
              request,
            )
            .catch(() => {});
      const live = job.deferDelivery
        ? undefined
        : new LiveReply(job, this.store, this.slack, signal, this.log, {
            waiting: {
              ...(await resolveWaiting(config)),
              name: botDisplayName(config),
            },
            phrase: waitingPhrase,
            allowed: () => allowed(job),
          });
      let reacted = false;
      let admitted = false;
      let silent = false;
      let reactionDelivered = false;
      let reactionTask: Promise<void> | undefined;
      let activity: ActivityHandle | undefined;
      let maintenance: Awaited<ReturnType<typeof startMaintenanceDelivery>>;
      let session: string | undefined;
      let from: string | undefined;
      let transcript: FinalTranscript | undefined;
      let captain: CaptainCursor | undefined;
      let captainCommit: CaptainTranscript | undefined;
      let keep = 0;
      let files: PublishedFile[] = [];
      const reply = (text: string, complete: boolean) => {
        if (job.deferDelivery)
          return parseAttachments(
            parseReactionReply(text, complete).text,
            complete,
          ).text;
        const parsed = parseReactionReply(text, complete);
        // A silent turn needs no "working" notice; the final cleanup removes
        // one that is already shown.
        if (parsed.silent && !complete) live?.quiet();
        if (
          allowed(job) &&
          this.slack.react &&
          parsed.reaction &&
          !job.slackReaction &&
          !reacted &&
          !signal.aborted
        ) {
          reacted = true;
          // eventId deduplicates by channel:message-ts, not Slack's envelope ID.
          const messageTs = job.eventId.slice(job.channel.length + 1);
          reactionTask = this.slack
            .react(job.channel, messageTs, parsed.reaction, () => allowed(job))
            .then(() => {
              reactionDelivered = true;
            })
            .catch(() =>
              this.log.warn({ job: job.id }, "Slack reaction unavailable"),
            );
        }
        return parseAttachments(parsed.text, complete).text;
      };
      try {
        try {
          signal.throwIfAborted();
          const pinned = this.backend.sessionID;
          session = pinned ? undefined : this.store.session(job.conversation);
          let text = job.text;
          if (job.notification?.note)
            text = `${job.notification.note}\n\n${text}`;
          const instructions = transport.instructions?.(job);
          if (instructions) text = `${instructions}\n\n${text}`;
          // Chat messages only. Digest runs have no thread.
          const source = job.deferDelivery
            ? undefined
            : (fleetResultSource(job) ?? transport.source(job));
          const sourceContext: PromptSourceContext | undefined =
            pinned && source ? { source } : undefined;
          // Unpinned adapters, including Pi, do not receive ordinary source context.
          if (!pinned && source?.reaction)
            text = `${sourceLine({ source })}\n\n${text}`;
          // Without a source line, the prompt itself names a special sender.
          const note = sourceContext ? undefined : transport.note(job);
          if (note) text = `${note}\n\n${text}`;
          if (
            job.textMention &&
            !(transport.name === "irc" && job.textMention.startsWith("@"))
          )
            text = `${textMentionNote(job.textMention)}\n\n${text}`;
          // greybeard: pinned turns carry IDs only; missing history needs explicit retrieval.
          if (!pinned && !session && bot) {
            // Roots (including scheduled runs) have no earlier thread messages.
            if (
              bot.threadContext &&
              source &&
              !source.reaction &&
              source.message !== job.thread
            ) {
              if (!this.slack.threadContext)
                throw new ThreadContextUnavailable();
              const history = await this.slack.threadContext({
                channel: job.channel,
                thread: job.thread,
                before: source.message,
                user: job.user,
                botUser: this.identity.user,
                appId: bot.slack.appId,
                team: this.identity.team,
                signal,
              });
              text = withThreadContext(text, history);
              signal.throwIfAborted();
            }
          }
          if (!session) {
            session = await this.backend.createSession({
              key: job.conversation,
              title: `${botDisplayName(config)} (${job.deferDelivery ? "scheduled" : transport.name} ${job.channel})`,
              signal,
            });
            if (pinned) {
              if (session !== pinned)
                throw new Error("Pinned session identity changed");
            } else {
              // A new unpinned session's transcript starts with this turn.
              this.store.saveSession(
                job.conversation,
                session,
                this.backend.transcript ? "" : undefined,
              );
            }
          }
          signal.throwIfAborted();
          if (!pinned && transport.sessionReady)
            await transport.sessionReady(session, signal).catch(() => {});
          signal.throwIfAborted();
          this.unavailable.delete(this.catchUpKey(job.conversation));
          if (pinned) {
            captain = this.store.captainCursor(this.key, pinned);
            from = captain.cursor;
            if (from === undefined && this.backend.transcript) {
              try {
                const baseline = await this.backend.transcript(
                  session,
                  undefined,
                  signal,
                );
                captain = this.store.baselineCaptain(
                  this.key,
                  pinned,
                  baseline.cursor,
                );
                from = captain.cursor;
              } catch (error) {
                if (signal.aborted) throw error;
                this.log.warn(
                  "Captain baseline unavailable; using input boundary",
                );
              }
            }
          } else
            from = await this.transcriptFrom(job.conversation, session, signal);
          signal.throwIfAborted();
          // No notice can be delivered for a digest run, and only Slack has a
          // cancel button. Without a permit the backend keeps that tool
          // fail-closed.
          maintenance =
            live && transport.name === "slack"
              ? await startMaintenanceDelivery({
                  backend: this.backend,
                  sessionID: session,
                  requestID: `slack-job-${job.id}`,
                  signal,
                  publish: async (notice) => {
                    if (!allowed(job))
                      throw new Error("Maintenance notice access denied");
                    await live.announce(maintenanceText(notice));
                    budget.pause();
                  },
                  resume: () => {
                    budget.resume();
                    live.resume();
                  },
                  cancel: () => {
                    this.log.warn(
                      { job: job.id },
                      "Maintenance monitoring failed; stopping request",
                    );
                    maintenanceFailure.abort();
                  },
                })
              : undefined;
          if (!job.deferDelivery)
            activity = await this.activity.start(
              job,
              session,
              signal,
              shutdown,
            );
          const fileIDs = this.store.inputFiles(job.id);
          let inputFiles: Attachment[] = [];
          // A spoken-mention gate already transcribed this message.
          if (heard) {
            if (heard.files.length && !this.backend.supportsAttachments)
              throw new AttachmentInputUnavailable();
            inputFiles = heard.files;
            text = [text, spokenMentionNote, ...heard.blocks]
              .filter(Boolean)
              .join("\n\n");
          } else if (fileIDs.length) {
            try {
              if (
                job.deferDelivery ||
                !this.slack.files ||
                !(this.backend.supportsAttachments || transcriber)
              )
                throw new Error(
                  "Attachment input is unavailable for this backend",
                );
              inputFiles = await this.slack.files.download(
                fileIDs,
                job.channel,
                signal,
              );
              checkAttachments(inputFiles);
              if (inputFiles.length !== fileIDs.length)
                throw new Error("Some requested attachments are unavailable");
              // Refuse before any audio leaves: speech alone needs no file input.
              if (
                !this.backend.supportsAttachments &&
                !inputFiles.every(isMedia)
              )
                throw new Error("Backend accepts no files");
            } catch {
              signal.throwIfAborted();
              throw new AttachmentInputUnavailable();
            }
            signal.throwIfAborted();
            // Speech becomes prompt text before admission; the media is dropped.
            if (transcriber && inputFiles.some(isMedia)) {
              const spoken = await transcribeMedia(
                inputFiles,
                transcriber,
                config.transcription?.timeoutMs ?? 120_000,
                signal,
              );
              inputFiles = spoken.files;
              text = [
                text,
                ...(job.gate === "admitted" ? [spokenMentionNote] : []),
                ...spoken.blocks,
              ]
                .filter(Boolean)
                .join("\n\n");
            }
          }
          this.store.started(job.id);
          admitted = true;
          await this.updateNotice?.(session, signal).catch(() =>
            this.log.warn("Update notice unavailable"),
          );
          const streamed = await this.backend.prompt(
            session,
            text,
            signal,
            live ? (text) => live.push(reply(text, false)) : undefined,
            pinned ||
              (this.questions &&
                (this.transport.questions || this.slackQuestions))
              ? (input) => {
                  this.store.saveInput(this.key, job.id, input, pinned);
                  if (pinned && captain?.cursor === undefined) {
                    captain = this.store.captainCursor(this.key, pinned);
                    from = captain.cursor;
                  }
                }
              : undefined,
            inputFiles,
            sourceContext,
            observeProgress
              ? (update) => {
                  // Backend completion can precede durable reply delivery.
                  if (update.stage !== "completed") progress = update;
                  if (turnStatus === "live")
                    this.store.saveTurnProgress(job.id, update);
                }
              : undefined,
            turnStatus === "live",
          );
          if (turnStatus === "live")
            this.store.saveTurnProgress(job.id, {
              stage: "completed",
              observedAt: Date.now(),
            });
          // A concurrent native receipt must settle before final link capture.
          await this.followUpTask;
          // History may become readable only as the original turn settles.
          // Resolve its held receipts once more before capturing final links.
          await this.pollFollowUps(signal, job.id);
          signal.throwIfAborted();
          // The prompt reply is this request's own text: only it can react.
          // Text-free steps before the first text leave only blank lines.
          const settled = streamed.replace(/^(?:\r?\n)+/, "");
          const own = reply(settled, true);
          const ownReply = parseReactionReply(settled);
          if (this.backend.transcript)
            transcript = await this.finalTranscript(session, from, signal);
          signal.throwIfAborted();
          // Settled history covers every public reply since the last delivery.
          // The streamed copy is used only for a mapping without any cursor.
          const owned =
            transcript && captain
              ? this.captainTranscript(session, captain, transcript, job.id)
              : undefined;
          captainCommit = owned?.commit;
          files = owned
            ? owned.files
            : transcript
              ? transcriptAttachments(transcript.entries)
              : parseAttachments(ownReply.text).files;
          const answerText = owned
            ? owned.text
            : transcript
              ? this.transcriptText(transcript)
              : own;
          const answer = this.followUpAnswer(job.id, answerText);
          silent = ownReply.silent || owned?.silent === true;
          // Unread or unsettled text is never posted without its cursor.
          const unread = transcript
            ? transcript.pending && !answer.trim()
            : from !== undefined ||
              (pinned !== undefined && this.backend.transcript !== undefined);
          if (unread || transcript?.pending)
            this.queueTranscript(this.catchUpKey(job.conversation));
          // This request's own reply is silent: there is no text to wait for.
          const deferred = unread && !ownReply.silent;
          activity?.finish();
          if (deferred) {
            failure = "history";
            output = [statusText(failure)];
          } else
            output =
              (reacted || silent) && !answer.trim()
                ? []
                : transcript && answer.trim()
                  ? this.prepare(answer, true)
                  : this.prepare(answer);
          if (transcript) keep = deferred ? 0 : output.length;
        } catch (error) {
          if (cancellation.signal.aborted || maintenanceFailure.signal.aborted)
            activity?.cancel();
          else if (!shutdown.aborted) activity?.finish();
          if (error instanceof PromptNotSubmitted) admitted = false;
          silent = false;
          failure = cancellation.signal.aborted
            ? "cancelled"
            : shutdown.aborted
              ? "interrupted"
              : budget.controller.signal.aborted
                ? "timeout"
                : errorFailure(error);
          // Category, provider status and backend only: never error text.
          const detail = providerFailure(failure);
          this.log.warn(
            {
              job: job.id,
              backend: config.backend.type,
              failure: detail?.kind ?? failure,
              ...(failure === "timeout" && progress
                ? {
                    lastStage: progress.stage,
                    lastStageAgeMs: Date.now() - progress.observedAt,
                  }
                : {}),
              ...(detail?.status ? { status: detail.status } : {}),
              ...(detail ? { ran: detail.ran } : {}),
            },
            "Agent request failed or timed out",
          );
          output = [
            failure === "timeout" && observeProgress
              ? `${statusText(failure)} ${turnProgressText(progress)}`
              : statusText(failure),
          ];
          transcript = undefined;
          // A request refused before admission submitted no input and owns no
          // text: reading history for it could assign another source's reply
          // to this thread. Earlier continuations stay with catch-up.
          if (this.backend.transcript && session && !admitted)
            this.queueTranscript(this.catchUpKey(job.conversation));
          // Keep public text that settled before the failure; shutdown recovers later.
          if (
            this.backend.transcript &&
            session &&
            admitted &&
            failure !== "interrupted"
          ) {
            transcript = await this.finalTranscript(
              session,
              from,
              AbortSignal.any([shutdown, AbortSignal.timeout(10_000)]),
            );
            if (transcript ? transcript.pending : from !== undefined)
              this.queueTranscript(this.catchUpKey(job.conversation));
            const owned =
              transcript && captain
                ? this.captainTranscript(session, captain, transcript, job.id)
                : undefined;
            captainCommit = owned?.commit;
            const text = owned
              ? owned.text
              : transcript
                ? this.transcriptText(transcript)
                : "";
            if (text)
              output = [
                ...this.prepare(this.followUpAnswer(job.id, text), true),
                ...output,
              ];
            keep = output.length - 1;
          }
        }
        // A reaction-only reply has no answer to preserve until delivery settles.
        // A silent reply stays silent, also when its optional reaction fails.
        if (output.length === 0 && !silent) {
          await reactionTask;
          if (!reactionDelivered) {
            failure = "reaction";
            output = [statusText(failure)];
          }
        }
        // Completion commits before awaiting preview cleanup. A late Stop cannot erase it.
        try {
          output = this.store.respond(job.id, output, failure, {
            keep,
            ...(captainCommit ? { captain: captainCommit } : {}),
            files,
            ...(transcript && !this.backend.sessionID
              ? { transcript: { from, cursor: transcript.cursor } }
              : {}),
          });
        } catch (error) {
          if (!(error instanceof TranscriptConflict)) throw error;
          // Another writer moved the cursor: catch-up delivers from there.
          failure = "history";
          output = this.store.respond(job.id, [statusText(failure)], failure);
          this.queueTranscript(this.catchUpKey(job.conversation));
        }
        failure = this.store.failure(job.id);
      } finally {
        typing.abort();
        await working;
        await maintenance?.close();
        budget.close();
        this.cancellations.delete(job.id);
        await live?.close();
        await reactionTask;
      }
    } else {
      output = JSON.parse(job.response ?? "[]") as ReplyChunk[];
    }
    const delivered = await this.deliver(
      job,
      output,
      failure,
      shutdown,
      allowed,
      readReceipt,
    );
    // Try the final reply first. A known failure can still be reported
    // when its error reply remains unconfirmed.
    if (failure && knownRequestFailure(failure)) publishOutcome("failed");
    else if (delivered && !failure) publishOutcome("completed");
  }

  /** The store refused a transition: the job is not in the expected status. */
  private refused(job: Job, transition: "finish" | "sent" | "retry" | "mute") {
    this.log.error(
      { job: job.id, transition },
      "Job transition refused; nothing was written",
    );
  }

  /**
   * Deliver a stored reply from its cursor: remove surplus previews, post or
   * update each chunk, then publish files. Never calls the backend. A
   * failure retries delivery only; the last retry fails the job.
   */
  private async deliver(
    job: Job,
    output: ReplyChunk[],
    failure: RequestFailure | undefined,
    shutdown: AbortSignal,
    allowed: (job: Job) => boolean,
    /** Slack: mark the request as read (`false`: after its last chunk). */
    readReceipt: (active: boolean) => Promise<void>,
  ) {
    if (job.deferDelivery) {
      if (!this.store.sent(job.id, output.length) || !this.store.finish(job.id))
        this.refused(job, "finish");
      return;
    }
    try {
      const previews = new Map(
        this.store.previews(job.id).map(({ part, ts }) => [part, ts]),
      );
      // A corrected answer, error, or recovery notice may be shorter than its preview.
      for (const [part, ts] of previews) {
        if (part < output.length) continue;
        if (shutdown.aborted) return;
        if (!this.slack.remove)
          throw new Error("Slack preview cleanup unavailable");
        await this.slack.remove(job.channel, ts);
        this.store.removePreview(job.id, part);
      }
      for (let i = job.sent; i < output.length; i++) {
        if (shutdown.aborted) return;
        if (!allowed(job)) throw new Error("Delivery access denied");
        const chunk = output[i];
        if (chunk === undefined) continue;
        const text = replyText(chunk);
        // Persisted classification is final: never derive it again here.
        const content = typeof chunk === "string" ? undefined : chunk.content;
        const ts = previews.get(i);
        let posted: string | undefined;
        // Only the final chunk is the status; earlier chunks are public text.
        if (failure && this.slack.failure && i === output.length - 1) {
          const result = await this.slack.failure(
            job.channel,
            job.thread,
            failure,
            ts,
          );
          if (result === false) {
            this.store.removePreview(job.id, i);
            const replacement = await this.slack.failure(
              job.channel,
              job.thread,
              failure,
            );
            if (typeof replacement === "string") posted = replacement;
          } else if (!ts && typeof result === "string") {
            posted = result;
          }
        } else {
          if (ts && !this.slack.update)
            throw new Error("Slack preview update unavailable");
          if (
            !ts ||
            (await this.slack.update?.(
              job.channel,
              ts,
              text,
              undefined,
              content,
            )) === false
          ) {
            if (ts) this.store.removePreview(job.id, i);
            posted =
              (await this.slack.post(
                job.channel,
                job.thread,
                text,
                undefined,
                { job: job.id, part: i, allowed: () => allowed(job) },
                content,
              )) || undefined;
          }
        }
        const slackTs = this.bot ? posted : undefined;
        if (!this.store.sent(job.id, i + 1, slackTs))
          return this.refused(job, "sent");
      }
      await deliverAttachments(
        job,
        {
          store: this.store,
          transport: this.slack.files,
          local: agentFilesLocal(this.config.backend),
          notify: (text) =>
            this.slack.post(job.channel, job.thread, text, undefined, {
              allowed: () => allowed(job),
            }),
          allowed: () => allowed(job),
        },
        shutdown,
      );
      if (output.length > 0) await readReceipt(false);
      if (this.store.finish(job.id)) return true;
      this.refused(job, "finish");
    } catch {
      this.log.warn({ job: job.id }, "Slack delivery failed");
      if (job.attempts >= 7) {
        if (
          allowed(job) &&
          this.store.attachments(job.id).some((file) => file.phase !== "shared")
        )
          await this.slack
            .post(
              job.channel,
              job.thread,
              "Attachment delivery failed or is unconfirmed. The agent work was not rerun.",
              undefined,
              { allowed: () => allowed(job) },
            )
            .catch(() => {});
        if (!this.store.finish(job.id, "failed")) this.refused(job, "finish");
      } else if (
        !this.store.retry(
          job.id,
          Date.now() + Math.min(60_000, 1000 * 2 ** job.attempts),
        )
      )
        this.refused(job, "retry");
    }
  }

  async close() {
    await this.activity.close();
  }
}
