import { setTimeout as delay } from "node:timers/promises";
import { Effect, FiberMap, Schedule } from "effect";
import type { Logger } from "pino";
import type { ActivityView } from "./activity";
import { ActivityDelivery, type ActivityHandle } from "./activity-delivery";
import {
  type Attachment,
  checkAttachments,
  inspectAttachment,
  maxAttachments,
  maxAttachmentTotalBytes,
  type PublishedFile,
  parseAttachments,
  readPreparedAttachment,
  UploadRefused,
} from "./attachments";
import {
  type AgentBackend,
  latestInput,
  type PromptSourceContext,
  type Transcript,
  type TranscriptEntry,
  TranscriptUnavailable,
} from "./backend";
import { cancellationTarget } from "./cancellation";
import type { BotConfig } from "./config";
import { abortable, runAbortable } from "./effect";
import { maintenanceText, TurnBudget } from "./maintenance";
import { startMaintenanceDelivery } from "./maintenance-delivery";
import { textMentionNote } from "./mentions";
import {
  botSender,
  type PeerDirectory,
  type PeerSender,
  peerLookupMs,
  peerPrefix,
  peerTurnsPerHour,
  peerWindowMs,
} from "./peers";
import { parseReactionReply, type ReactionName } from "./reactions";
import {
  AttachmentInputUnavailable,
  failureText,
  type RequestFailure,
} from "./request-failure";
import {
  botKey,
  chunks,
  conversationKey,
  type Identity,
  isAllowedChannel,
  isAllowedUser,
  routeEvent,
  transcriptChunks,
} from "./routing";
import { type ReplyChunk, replyText, type SlackContent } from "./slack-format";
import {
  type CaptainCursor,
  type CaptainTranscript,
  type Incoming,
  type Job,
  type Store,
  TranscriptConflict,
} from "./store";
import { LiveReply } from "./streaming";
import {
  type ThreadContext,
  type ThreadContextRequest,
  ThreadContextUnavailable,
  withThreadContext,
} from "./thread-context";
import {
  isMedia,
  spokenMention,
  spokenMentionNote,
  type Transcriber,
  TranscriptionUnavailable,
  transcribeMedia,
} from "./transcription";
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
  "_Pogo could not find its last delivered message in session history; earlier replies may be missing. This reply starts at your request._";

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

/** Slack-style three-step upload: reserve, put, then complete in a thread. */
export interface UploadTransport {
  reserveUpload(
    name: string,
    length: number,
    signal: AbortSignal,
  ): Promise<{ fileID: string; url: string }>;
  putUpload(url: string, data: Uint8Array, signal: AbortSignal): Promise<void>;
  completeUpload(
    channel: string,
    thread: string,
    fileID: string,
    title: string,
    signal: AbortSignal,
  ): Promise<void>;
  sharedIn(
    fileID: string,
    channel: string,
    thread: string,
    signal: AbortSignal,
  ): Promise<boolean>;
}

/**
 * One-step upload (IRC FILEHOST): a durable URL, then a link in the thread.
 * "uploading" is stored before the upload and the URL before the link is
 * posted, so a retry never uploads a file again: an upload that may have
 * run (crash, lost answer, timeout) makes the file unavailable with a
 * notice. Only `UploadRefused` (the host certainly stored nothing, for
 * example a 401 or 413 from a FILEHOST) allows another upload. A crash
 * between post and record can repeat the link.
 */
export interface LinkTransport {
  upload(file: Attachment, signal: AbortSignal): Promise<string>;
  link(
    channel: string,
    thread: string,
    url: string,
    title: string,
    signal: AbortSignal,
  ): Promise<void>;
}

/** Input downloads, plus uploads when the transport can publish files. */
export interface AttachmentTransport
  extends Partial<UploadTransport>,
    Partial<LinkTransport> {
  download(
    ids: readonly string[],
    channel: string,
    signal: AbortSignal,
  ): Promise<Attachment[]>;
}

/** The transport's link-style upload half, if it has one. */
function links(
  transport: AttachmentTransport | undefined,
): LinkTransport | undefined {
  if (!transport?.upload || !transport.link) return;
  const { upload, link } = transport;
  return { upload: upload.bind(transport), link: link.bind(transport) };
}

/** The transport's upload half, or undefined for a download-only one. */
function uploads(
  transport: AttachmentTransport | undefined,
): UploadTransport | undefined {
  if (
    !transport?.reserveUpload ||
    !transport.putUpload ||
    !transport.completeUpload ||
    !transport.sharedIn
  )
    return;
  const { reserveUpload, putUpload, completeUpload, sharedIn } = transport;
  return {
    reserveUpload: reserveUpload.bind(transport),
    putUpload: putUpload.bind(transport),
    completeUpload: completeUpload.bind(transport),
    sharedIn: sharedIn.bind(transport),
  };
}

/** One stored reply chunk of one job. */
export type DeliveryUnit = { job: number; part: number };

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
  post(
    channel: string,
    thread: string,
    text: string,
    stopJob?: number,
    /** Final delivery of stored chunk `part`: lets a transport keep progress. */
    unit?: DeliveryUnit,
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
  react?(channel: string, ts: string, name: ReactionName): Promise<void>;
  /**
   * Show that a turn is running (IRC +typing) until `signal` aborts, then
   * clear it. Best effort: failures never affect the turn.
   */
  working?(channel: string, thread: string, signal: AbortSignal): Promise<void>;
}

/**
 * Registration settings the transport-neutral worker reads. A Slack
 * `BotConfig` carries `slack` and enables Slack-only intake and controls.
 */
export type GatewayConfig =
  | BotConfig
  | Pick<
      BotConfig,
      | "id"
      | "displayName"
      | "backend"
      | "concurrency"
      | "turnTimeoutMs"
      | "waiting"
      | "crewActivity"
      | "transcription"
    >;

/** Transport rules the gateway applies to every job of one registration. */
export interface GatewayTransport {
  /** Session title and source label. */
  readonly name: "slack" | "irc";
  /** Queue, session and outbox namespace of this registration. */
  readonly key: string;
  /** Current access rules, rechecked before work and before delivery. */
  allowed(user: string, channel: string): boolean;
  /** Model-visible source of a chat message; undefined for other jobs. */
  source(job: Job): PromptSourceContext["source"] | undefined;
  /** Prompt prefix naming the sender when no source line is sent. */
  note(job: Job): string | undefined;
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
  private readonly bot: BotConfig | undefined;
  private readonly transport: GatewayTransport;
  readonly key: string;
  constructor(
    private readonly config: GatewayConfig,
    private readonly identity: Identity,
    private readonly store: Store,
    private readonly backend: AgentBackend,
    private readonly slack: SlackDelivery,
    private readonly log: Logger,
    /** Present only when the bot configures transcription. */
    private readonly transcriber?: Transcriber,
    /** Slack user directory for peer captain checks. */
    private readonly peers?: PeerDirectory,
    /** Defaults to Slack rules for a Slack `BotConfig`. */
    transport?: GatewayTransport,
  ) {
    this.bot = "slack" in config ? config : undefined;
    const selected =
      transport ?? (this.bot ? slackTransport(this.bot, identity) : undefined);
    if (!selected) throw new Error("Gateway transport is required");
    this.transport = selected;
    this.key = selected.key;
    this.activity = new ActivityDelivery(
      backend,
      slack,
      () => config.crewActivity,
      (job) => !job.deferDelivery && selected.allowed(job.user, job.channel),
      log,
      { store },
    );
  }

  /** Classify one whole reply once; chunks carry their own content. */
  private prepare(text: string, unbounded = false): ReplyChunk[] {
    return (
      this.slack.prepareReply?.(text, unbounded) ??
      (unbounded ? transcriptChunks(text) : chunks(text))
    );
  }

  private allowed(job: { user: string; channel: string }) {
    return this.transport.allowed(job.user, job.channel);
  }

  accept(body: unknown, peer?: PeerSender) {
    const bot = this.bot;
    if (!bot) return false;
    const routed = routeEvent(body, bot, this.identity, peer);
    if (!routed) return false;
    const followed = this.store.follows(routed.conversation);
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
          peerTurnsPerHour)
    ) {
      this.log.warn("Peer captain thread limit reached; message not admitted");
      return false;
    }
    return this.store.enqueue(input);
  }

  /**
   * Slack intake. A bot message is admitted only after Slack's directory
   * proves a peer captain; a failed or slow lookup admits nothing. `open` is
   * checked again after the lookup, before anything is stored.
   */
  async receive(body: unknown, open: () => boolean = () => true) {
    const sender = botSender(body);
    if (!sender || !this.bot?.access.peerCaptains || !this.peers)
      return this.accept(body);
    const verified = await this.peers
      .verify(sender, AbortSignal.timeout(peerLookupMs))
      .catch(() => false);
    if (!open()) return false;
    return this.accept(body, verified ? sender : undefined);
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
    this.cancellations.get(id)?.abort();
    return true;
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
        status: Job["status"];
        failure?: RequestFailure | null;
      }
    | undefined {
    return this.store.scheduledResult(this.key, jobId);
  }

  /**
   * Supervise this bot until the signal aborts. One scope owns the per-
   * conversation slots, the transcript watch and activity reporting. A failed
   * poll closes that scope, stops the watch and rejects, so the runtime can
   * restart Pogo instead of leaving a silent, half-stopped worker.
   */
  async work(signal: AbortSignal) {
    await runAbortable(this.supervise(), signal).catch((error: unknown) => {
      if (!signal.aborted) throw error;
    });
  }

  private supervise() {
    const gateway = this;
    return Effect.scoped(
      Effect.gen(function* () {
        yield* abortable((signal) => gateway.recover(signal));
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
    const interrupted = this.backend.sessionID
      ? []
      : this.store.interruptedSessions(this.key);
    if (this.backend.sessionID) {
      const input = this.store.interruptedInput(this.key);
      if (input && this.backend.interruptInput) {
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
      await this.backend.interrupt?.(session, AbortSignal.timeout(5000));
    }
    this.store.recover(this.key);
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
      const used = yield* FiberMap.size(slots);
      const jobs = gateway.store.ready(
        gateway.key,
        Date.now(),
        gateway.config.concurrency + used,
        gateway.backend.sessionID !== undefined,
      );
      for (const job of jobs) {
        if ((yield* FiberMap.size(slots)) >= gateway.config.concurrency) break;
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
                  chunks: this.prepare(text, true),
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
  ): Promise<Awaited<ReturnType<typeof transcribeMedia>> | undefined> {
    const mention = this.bot?.transcription?.spokenMentions;
    const timeoutMs = this.bot?.transcription?.timeoutMs ?? 120_000;
    const ignore = (message: string) => {
      this.log.info({ job: job.id }, message);
      this.store.discard(job.id);
      return undefined;
    };
    if (
      !mention?.channels.includes(job.channel) ||
      !this.transcriber ||
      !this.slack.files
    )
      return ignore("Voice message ignored: spoken mentions not configured");
    let heard: Awaited<ReturnType<typeof transcribeMedia>>;
    try {
      const signal = AbortSignal.any([
        shutdown,
        AbortSignal.timeout(this.config.turnTimeoutMs),
      ]);
      const files = await this.slack.files.download(
        this.store.inputFiles(job.id),
        job.channel,
        signal,
      );
      checkAttachments(files);
      if (!files.some(isMedia))
        return ignore("Message without media or mention ignored");
      heard = await transcribeMedia(files, this.transcriber, timeoutMs, signal);
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
    // Recheck policy for queued inputs and pending delivery after a restart.
    if (!this.allowed(held)) {
      if (held.gate === "spoken") this.store.discard(held.id);
      else this.store.finish(held.id, "failed");
      return;
    }
    // A transcript held only in this call; a restart transcribes again.
    let heard: Awaited<ReturnType<typeof transcribeMedia>> | undefined;
    if (held.status === "queued" && held.gate === "spoken") {
      heard = await this.hear(held, shutdown);
      if (!heard) return;
    }
    const job: Job =
      held.gate === "spoken" ? { ...held, gate: "admitted" } : held;
    const statusText = (cause: RequestFailure) =>
      job.deferDelivery && cause === "history"
        ? "The agent finished, but its public reply is not yet readable in session history. Pogo will retain it locally when it becomes readable. The request was not repeated."
        : failureText(cause);
    let output: ReplyChunk[];
    let failure = job.failure ?? undefined;
    if (job.status === "queued") {
      if (!this.store.running(job.id)) return;
      // Ends before delivery, so a typing indicator never outlasts the turn.
      const typing = new AbortController();
      const working = job.deferDelivery
        ? undefined
        : this.slack
            .working?.(
              job.channel,
              job.thread,
              AbortSignal.any([typing.signal, shutdown]),
            )
            .catch(() => {});
      // Only an accepted requester Stop aborts this controller.
      const cancellation = new AbortController();
      const maintenanceFailure = new AbortController();
      const budget = new TurnBudget(this.config.turnTimeoutMs);
      this.cancellations.set(job.id, cancellation);
      const signal = AbortSignal.any([
        shutdown,
        cancellation.signal,
        maintenanceFailure.signal,
        budget.controller.signal,
      ]);
      const live = job.deferDelivery
        ? undefined
        : new LiveReply(job, this.store, this.slack, signal, this.log, {
            waiting: {
              ...(await resolveWaiting(this.config)),
              name: botDisplayName(this.config),
            },
            phrase: waitingPhrase,
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
          this.slack.react &&
          parsed.reaction &&
          !reacted &&
          !signal.aborted
        ) {
          reacted = true;
          // eventId deduplicates by channel:message-ts, not Slack's envelope ID.
          const messageTs = job.eventId.slice(job.channel.length + 1);
          reactionTask = this.slack
            .react(job.channel, messageTs, parsed.reaction)
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
          // Chat messages only. Digest runs have no thread.
          const source = job.deferDelivery
            ? undefined
            : this.transport.source(job);
          const sourceContext: PromptSourceContext | undefined =
            pinned && source ? { source } : undefined;
          // Without a source line, the prompt itself names a special sender.
          const note = sourceContext ? undefined : this.transport.note(job);
          if (note) text = `${note}\n\n${text}`;
          if (job.textMention)
            text = `${textMentionNote(job.textMention)}\n\n${text}`;
          // greybeard: pinned turns carry IDs only; missing history needs explicit retrieval.
          const bot = this.bot;
          if (!pinned && !session && bot) {
            // Roots (including scheduled runs) have no earlier thread messages.
            if (bot.threadContext && source && source.message !== job.thread) {
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
              title: `${botDisplayName(this.config)} (${job.deferDelivery ? "scheduled" : this.transport.name} ${job.channel})`,
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
          this.unavailable.delete(pinned ? this.key : job.conversation);
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
            live && this.transport.name === "slack"
              ? await startMaintenanceDelivery({
                  backend: this.backend,
                  sessionID: session,
                  requestID: `slack-job-${job.id}`,
                  signal,
                  publish: async (notice) => {
                    if (!this.allowed(job))
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
                !(this.backend.supportsAttachments || this.transcriber)
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
            if (this.transcriber && inputFiles.some(isMedia)) {
              const spoken = await transcribeMedia(
                inputFiles,
                this.transcriber,
                this.config.transcription?.timeoutMs ?? 120_000,
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
          const streamed = await this.backend.prompt(
            session,
            text,
            signal,
            live ? (text) => live.push(reply(text, false)) : undefined,
            pinned
              ? (input) => {
                  this.store.saveInput(this.key, job.id, input, pinned);
                  if (captain?.cursor === undefined) {
                    captain = this.store.captainCursor(this.key, pinned);
                    from = captain.cursor;
                  }
                }
              : undefined,
            inputFiles,
            sourceContext,
          );
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
          const answer = owned
            ? owned.text
            : transcript
              ? this.transcriptText(transcript)
              : own;
          silent = ownReply.silent || owned?.silent === true;
          // Unread or unsettled text is never posted without its cursor.
          const unread = transcript
            ? transcript.pending && !answer.trim()
            : from !== undefined ||
              (pinned !== undefined && this.backend.transcript !== undefined);
          if (unread || transcript?.pending)
            this.queueTranscript(pinned ? this.key : job.conversation);
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
          this.log.warn({ job: job.id }, "Agent request failed or timed out");
          silent = false;
          failure = cancellation.signal.aborted
            ? "cancelled"
            : shutdown.aborted
              ? "interrupted"
              : budget.controller.signal.aborted
                ? "timeout"
                : error instanceof ThreadContextUnavailable
                  ? "context"
                  : error instanceof AttachmentInputUnavailable
                    ? "attachments"
                    : error instanceof TranscriptionUnavailable
                      ? "transcription"
                      : "backend";
          output = [statusText(failure)];
          transcript = undefined;
          // A request refused before admission submitted no input and owns no
          // text: reading history for it could assign another source's reply
          // to this thread. Earlier continuations stay with catch-up.
          if (this.backend.transcript && session && !admitted)
            this.queueTranscript(
              this.backend.sessionID ? this.key : job.conversation,
            );
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
              this.queueTranscript(
                this.backend.sessionID ? this.key : job.conversation,
              );
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
            if (text) output = [...this.prepare(text, true), ...output];
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
          this.queueTranscript(
            this.backend.sessionID ? this.key : job.conversation,
          );
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
    if (job.deferDelivery) {
      this.store.sent(job.id, output.length);
      this.store.finish(job.id);
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
        const chunk = output[i];
        if (chunk === undefined) continue;
        const text = replyText(chunk);
        // Persisted classification is final: never derive it again here.
        const content = typeof chunk === "string" ? undefined : chunk.content;
        const ts = previews.get(i);
        // Only the final chunk is the status; earlier chunks are public text.
        if (failure && this.slack.failure && i === output.length - 1) {
          if (
            (await this.slack.failure(job.channel, job.thread, failure, ts)) ===
            false
          ) {
            this.store.removePreview(job.id, i);
            await this.slack.failure(job.channel, job.thread, failure);
          }
        } else if (ts) {
          if (!this.slack.update)
            throw new Error("Slack preview update unavailable");
          if (
            (await this.slack.update(
              job.channel,
              ts,
              text,
              undefined,
              content,
            )) === false
          ) {
            this.store.removePreview(job.id, i);
            await this.slack.post(
              job.channel,
              job.thread,
              text,
              undefined,
              { job: job.id, part: i },
              content,
            );
          }
        } else {
          await this.slack.post(
            job.channel,
            job.thread,
            text,
            undefined,
            { job: job.id, part: i },
            content,
          );
        }
        this.store.sent(job.id, i + 1);
      }
      await this.deliverAttachments(job, shutdown);
      this.store.finish(job.id);
    } catch {
      this.log.warn({ job: job.id }, "Slack delivery failed");
      if (job.attempts >= 7) {
        if (
          this.store.attachments(job.id).some((file) => file.phase !== "shared")
        )
          await this.slack
            .post(
              job.channel,
              job.thread,
              "Attachment delivery failed or is unconfirmed. The agent work was not rerun.",
            )
            .catch(() => {});
        this.store.finish(job.id, "failed");
      } else
        this.store.retry(
          job.id,
          Date.now() + Math.min(60_000, 1000 * 2 ** job.attempts),
        );
    }
  }

  private async deliverAttachments(job: Job, shutdown: AbortSignal) {
    const files = this.store.attachments(job.id);
    if (!files.length) return;
    const save = () => this.store.saveAttachments(job.id, files);
    const local =
      this.config.backend.type !== "opencode" ||
      ["localhost", "127.0.0.1", "[::1]"].includes(
        new URL(this.config.backend.url).hostname,
      );
    const linked = links(this.slack.files);
    const transport = linked ? undefined : uploads(this.slack.files);
    if (!local || files.length > maxAttachments || !(transport || linked)) {
      for (const file of files) file.phase = "unavailable";
      save();
    } else {
      for (const file of files) {
        if (file.phase || file.prepared) continue;
        try {
          file.prepared = await inspectAttachment(file);
        } catch {
          file.phase = "unavailable";
        }
        save();
      }
      if (
        files.reduce((sum, file) => sum + (file.prepared?.size ?? 0), 0) >
        maxAttachmentTotalBytes
      ) {
        for (const file of files)
          if (file.phase !== "shared") file.phase = "unavailable";
        save();
      }
    }
    for (const file of files) {
      shutdown.throwIfAborted();
      if (!this.allowed(job))
        throw new Error("Attachment delivery access denied");
      if (file.phase === "shared") continue;
      if (file.prepared && !file.title) {
        file.title =
          [...(file.caption || file.prepared.name)]
            .map((char) =>
              char === "/" ||
              char === "\\" ||
              char.charCodeAt(0) < 32 ||
              char.charCodeAt(0) === 127
                ? " "
                : char,
            )
            .join("")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 255)
            .trim() || file.prepared.name;
        save();
      }
      const signal = AbortSignal.any([shutdown, AbortSignal.timeout(30_000)]);
      if (file.phase === "completing" && file.fileID && transport) {
        if (
          await transport.sharedIn(file.fileID, job.channel, job.thread, signal)
        ) {
          file.phase = "shared";
          save();
          continue;
        }
        // Completion is one-shot. Absence of a share is not proof it never ran.
        file.phase = "unavailable";
        save();
      }
      if (file.phase === "uploading" && !file.fileID) {
        // The last upload attempt had no certain outcome: never repeat it.
        file.phase = "unavailable";
        save();
      }
      if (
        file.phase === "unavailable" ||
        !file.prepared ||
        !(transport || linked)
      ) {
        if (!file.noticeSent) {
          if (!files.some((item) => item.noticeSent))
            await this.slack.post(
              job.channel,
              job.thread,
              "An attachment is unavailable or its upload is unconfirmed. The agent work was not rerun.",
            );
          file.noticeSent = true;
          save();
        }
        continue;
      }
      if (linked) {
        // Record the hosted URL first: a retry posts it, never re-uploads.
        if (!file.fileID) {
          let content: Attachment;
          try {
            content = await readPreparedAttachment(file.prepared);
          } catch {
            file.phase = "unavailable";
            save();
            throw new Error(
              "Published attachment changed or became unavailable",
            );
          }
          file.phase = "uploading";
          save();
          try {
            file.fileID = await linked.upload(content, signal);
          } catch (error) {
            if (error instanceof UploadRefused) {
              delete file.phase;
              save();
            }
            throw error;
          }
          file.phase = "uploaded";
          save();
        }
        await linked.link(
          job.channel,
          job.thread,
          file.fileID,
          file.title ?? file.prepared.name,
          signal,
        );
        file.phase = "shared";
        save();
        continue;
      }
      if (!transport) continue;
      if (file.phase !== "uploaded") {
        let content: Attachment;
        try {
          content = await readPreparedAttachment(file.prepared);
        } catch {
          file.phase = "unavailable";
          save();
          throw new Error("Published attachment changed or became unavailable");
        }
        // A retry may abandon an unshared reservation, never complete both IDs.
        const reserved = await transport.reserveUpload(
          content.name,
          content.data.byteLength,
          signal,
        );
        file.fileID = reserved.fileID;
        file.phase = "reserved";
        save();
        await transport.putUpload(reserved.url, content.data, signal);
        file.phase = "uploaded";
        save();
      }
      if (!file.fileID) throw new Error("Attachment upload identity missing");
      file.phase = "completing";
      save();
      await transport.completeUpload(
        job.channel,
        job.thread,
        file.fileID,
        file.title ?? file.prepared.name,
        signal,
      );
      file.phase = "shared";
      save();
    }
  }

  async close() {
    await this.activity.close();
  }
}
