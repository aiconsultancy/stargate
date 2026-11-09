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
import {
  type CaptainCursor,
  type CaptainTranscript,
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

/** Settled public text without reaction controls; never applies a reaction. */
export function transcriptReply(entries: readonly TranscriptEntry[]) {
  return entries
    .map((entry) =>
      parseAttachments(parseReactionReply(entry.text).text).text.trim(),
    )
    .filter(Boolean)
    .join("\n\n");
}

export function transcriptAttachments(entries: readonly TranscriptEntry[]) {
  return [
    ...new Map(
      entries
        .flatMap((entry) => parseAttachments(entry.text).files)
        .map((file) => [file.path, file]),
    ).values(),
  ];
}

export interface AttachmentTransport {
  download(
    ids: readonly string[],
    channel: string,
    signal: AbortSignal,
  ): Promise<Attachment[]>;
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

export interface SlackDelivery {
  readonly files?: AttachmentTransport;
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
  ): Promise<string> | Promise<void>;
  /** false means the user removed the preview; post a replacement. */
  update?(
    channel: string,
    ts: string,
    text: string,
    stopJob?: number,
  ): Promise<boolean> | Promise<void>;
  remove?(channel: string, ts: string): Promise<void>;
  react?(channel: string, ts: string, name: ReactionName): Promise<void>;
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
  readonly key: string;
  constructor(
    private readonly config: BotConfig,
    private readonly identity: Identity,
    private readonly store: Store,
    private readonly backend: AgentBackend,
    private readonly slack: SlackDelivery,
    private readonly log: Logger,
  ) {
    this.key = botKey(config, identity);
    this.activity = new ActivityDelivery(
      backend,
      slack,
      () => config.crewActivity,
      (job) =>
        isAllowedUser(config, job.user) &&
        isAllowedChannel(config, job.channel),
      log,
      { store },
    );
  }

  accept(body: unknown) {
    const input = routeEvent(body, this.config, this.identity);
    if (
      !input ||
      (!input.startsConversation && !this.store.follows(input.conversation))
    )
      return false;
    return this.store.enqueue(input);
  }

  /** Commit the exact requester-authorized target before Socket Mode ACK. */
  cancel(body: unknown) {
    const target = cancellationTarget(body, this.config, this.identity);
    if (!target || !this.store.cancel(this.key, target)) return false;
    this.cancellations.get(target.id)?.abort();
    return true;
  }

  enqueueScheduled(input: {
    runId: string;
    channel: string;
    user: string;
    prompt: string;
    thread: string;
    name: string;
  }): number | undefined {
    if (
      !isAllowedUser(this.config, input.user) ||
      !isAllowedChannel(this.config, input.channel)
    )
      return;
    const eventId = `${input.channel}:${input.thread}`;
    this.store.enqueue({
      eventId,
      botKey: this.key,
      conversation: conversationKey(this.key, input.channel, input.thread),
      channel: input.channel,
      thread: input.thread,
      user: input.user,
      text: input.prompt,
    });
    return this.store.queuedJob(this.key, eventId)?.id;
  }

  scheduledStatus(jobId: number) {
    return this.store.jobStatus(this.key, jobId);
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
    if (
      !target ||
      !this.backend.transcript ||
      !isAllowedUser(this.config, target.user) ||
      !isAllowedChannel(this.config, target.channel)
    )
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
                  chunks: transcriptChunks(text),
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
  ): { commit: CaptainTranscript; text: string; files: PublishedFile[] } {
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
    return {
      text: transcriptReply(
        groups
          .filter((group) => group.job === current)
          .flatMap((group) => group.entries),
      ),
      files: transcriptAttachments(
        groups
          .filter((group) => group.job === current)
          .flatMap((group) => group.entries),
      ),
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
                  chunks: transcriptChunks(text),
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

  /** Public for deterministic integration tests and single-step workers. */
  async process(job: Job, shutdown: AbortSignal) {
    // Recheck policy for queued inputs and pending delivery after a restart.
    if (
      !isAllowedUser(this.config, job.user) ||
      !isAllowedChannel(this.config, job.channel)
    ) {
      this.store.finish(job.id, "failed");
      return;
    }
    let output: string[];
    let failure = job.failure ?? undefined;
    if (job.status === "queued") {
      if (!this.store.running(job.id)) return;
      const cancellation = new AbortController();
      const budget = new TurnBudget(this.config.turnTimeoutMs);
      this.cancellations.set(job.id, cancellation);
      const signal = AbortSignal.any([
        shutdown,
        cancellation.signal,
        budget.controller.signal,
      ]);
      const waiting = await resolveWaiting(this.config);
      const live = new LiveReply(
        job,
        this.store,
        this.slack,
        signal,
        this.log,
        {
          waiting: { ...waiting, name: botDisplayName(this.config) },
          phrase: waitingPhrase,
        },
      );
      let reacted = false;
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
        if (!this.slack.react) return parseAttachments(text, complete).text;
        const parsed = parseReactionReply(text, complete);
        if (parsed.reaction && !reacted && !signal.aborted) {
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
          const before = job.eventId.slice(job.channel.length + 1);
          const slackMessage =
            job.eventId.startsWith(`${job.channel}:`) &&
            /^\d{1,16}\.\d{1,6}$/.test(before);
          const sourceContext: PromptSourceContext | undefined =
            pinned && slackMessage
              ? {
                  source: {
                    channel: job.channel,
                    thread: job.thread,
                    message: before,
                    user: job.user,
                    team: this.identity.team,
                    app: this.config.slack.appId,
                  },
                }
              : undefined;
          if (pinned || !session) {
            // Roots (including scheduled runs) have no earlier thread messages.
            if (
              this.config.threadContext &&
              slackMessage &&
              before !== job.thread
            ) {
              if (!this.slack.threadContext)
                throw new ThreadContextUnavailable();
              const history = await this.slack.threadContext({
                channel: job.channel,
                thread: job.thread,
                before,
                user: job.user,
                botUser: this.identity.user,
                appId: this.config.slack.appId,
                team: this.identity.team,
                signal,
                ...(pinned
                  ? {
                      allowThreadRoot: (user: string) =>
                        isAllowedUser(this.config, user),
                    }
                  : {}),
              });
              if (sourceContext) sourceContext.history = history;
              else text = withThreadContext(text, history);
              signal.throwIfAborted();
            }
          }
          if (!session) {
            session = await this.backend.createSession({
              key: job.conversation,
              title: `${botDisplayName(this.config)} (slack ${job.channel})`,
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
          maintenance = await startMaintenanceDelivery({
            backend: this.backend,
            sessionID: session,
            requestID: `slack-job-${job.id}`,
            signal,
            publish: async (notice) => {
              if (
                !isAllowedUser(this.config, job.user) ||
                !isAllowedChannel(this.config, job.channel)
              )
                throw new Error("Maintenance notice access denied");
              await live.announce(maintenanceText(notice));
              budget.pause();
            },
            resume: () => {
              budget.resume();
              live.resume();
            },
            cancel: () => cancellation.abort(),
          });
          activity = await this.activity.start(job, session, signal, shutdown);
          const fileIDs = this.store.inputFiles(job.id);
          let inputFiles: Attachment[] = [];
          if (fileIDs.length) {
            try {
              if (!this.slack.files || !this.backend.supportsAttachments)
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
            } catch {
              signal.throwIfAborted();
              throw new AttachmentInputUnavailable();
            }
            signal.throwIfAborted();
          }
          this.store.started(job.id);
          const streamed = await this.backend.prompt(
            session,
            text,
            signal,
            (text) => live.push(reply(text, false)),
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
          const own = reply(streamed, true);
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
              : parseAttachments(streamed).files;
          const answer = owned
            ? owned.text
            : transcript
              ? this.transcriptText(transcript)
              : own;
          // Unread or unsettled text is never posted without its cursor.
          const deferred = transcript
            ? transcript.pending && !answer.trim()
            : from !== undefined ||
              (pinned !== undefined && this.backend.transcript !== undefined);
          if (deferred || transcript?.pending)
            this.queueTranscript(pinned ? this.key : job.conversation);
          activity?.finish();
          if (deferred) {
            failure = "history";
            output = [failureText(failure)];
          } else
            output =
              reacted && !answer.trim()
                ? []
                : transcript && answer.trim()
                  ? transcriptChunks(answer)
                  : chunks(answer);
          if (transcript) keep = deferred ? 0 : output.length;
        } catch (error) {
          if (cancellation.signal.aborted) activity?.cancel();
          else if (!shutdown.aborted) activity?.finish();
          this.log.warn({ job: job.id }, "Agent request failed or timed out");
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
                    : "backend";
          output = [failureText(failure)];
          transcript = undefined;
          // Keep public text that settled before the failure; shutdown recovers later.
          if (this.backend.transcript && session && failure !== "interrupted") {
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
            if (text) output = [...transcriptChunks(text), ...output];
            keep = output.length - 1;
          }
        }
        // A reaction-only reply has no answer to preserve until delivery settles.
        if (output.length === 0) {
          await reactionTask;
          if (!reactionDelivered) {
            failure = "reaction";
            output = [failureText(failure)];
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
          output = this.store.respond(job.id, [failureText(failure)], failure);
          this.queueTranscript(
            this.backend.sessionID ? this.key : job.conversation,
          );
        }
        failure = this.store.failure(job.id);
      } finally {
        await maintenance?.close();
        budget.close();
        this.cancellations.delete(job.id);
        await live.close();
        await reactionTask;
      }
    } else {
      output = JSON.parse(job.response ?? "[]") as string[];
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
        const text = output[i];
        if (text === undefined) continue;
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
          if ((await this.slack.update(job.channel, ts, text)) === false) {
            this.store.removePreview(job.id, i);
            await this.slack.post(job.channel, job.thread, text);
          }
        } else {
          await this.slack.post(job.channel, job.thread, text);
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
    if (!local || files.length > maxAttachments || !this.slack.files) {
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
      if (
        !isAllowedUser(this.config, job.user) ||
        !isAllowedChannel(this.config, job.channel)
      )
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
      const transport = this.slack.files;
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
      if (file.phase === "unavailable" || !file.prepared || !transport) {
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
