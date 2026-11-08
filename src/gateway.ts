import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import type { ActivityView } from "./activity";
import { ActivityDelivery, type ActivityHandle } from "./activity-delivery";
import {
  type AgentBackend,
  latestInput,
  type Transcript,
  type TranscriptEntry,
  TranscriptUnavailable,
} from "./backend";
import { cancellationTarget } from "./cancellation";
import type { BotConfig } from "./config";
import {
  parseReactionReply,
  type ReactionName,
  reactionInstructions,
} from "./reactions";
import { failureText, type RequestFailure } from "./request-failure";
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
import { type Job, type Store, TranscriptConflict } from "./store";
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

/** Settled public text without reaction controls; never applies a reaction. */
export function transcriptReply(entries: readonly TranscriptEntry[]) {
  return entries
    .map((entry) => parseReactionReply(entry.text).text.trim())
    .filter(Boolean)
    .join("\n\n");
}

export interface SlackDelivery {
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
  private readonly active = new Map<string, Promise<void>>();
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

  async work(signal: AbortSignal) {
    for (const session of this.store.interruptedSessions(this.key)) {
      // Stop surviving backend work before a fresh turn can resume it.
      await this.backend.interrupt?.(session, AbortSignal.timeout(5000));
    }
    this.store.recover(this.key);
    // Restart catch-up for every mapping; unbaselined ones seed at current history.
    if (this.backend.transcript) this.settle();
    const watching = this.backend.transcript
      ? this.backend.watch?.((session) => this.settle(session), signal)
      : undefined;
    try {
      while (!signal.aborted) {
        const jobs = this.store.ready(
          this.key,
          Date.now(),
          this.config.concurrency + this.active.size,
        );
        for (const job of jobs) {
          if (this.active.size >= this.config.concurrency) break;
          if (this.active.has(job.conversation)) continue;
          const task = this.process(job, signal)
            .catch(() => {
              this.log.error(
                { job: job.id },
                "Worker failed; request will need recovery",
              );
            })
            .finally(() => {
              this.active.delete(job.conversation);
            });
          this.active.set(job.conversation, task);
        }
        // Started tasks are tracked in `active` and awaited during shutdown.
        void this.catchUp(signal);
        await delay(200, undefined, { signal });
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      await Promise.all(this.active.values());
      await watching?.catch(() => this.log.warn("Transcript watch stopped"));
      await this.activity.close();
    }
  }

  /** Queue catch-up for a settled session, or every mapped thread on connect. */
  settle(session?: string) {
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
    const tasks: Promise<void>[] = [];
    const now = Date.now();
    for (const [conversation, retry] of this.settled) {
      if (this.active.size >= this.config.concurrency) break;
      // A pending turn reads the same history; later replies wait for delivery.
      if (
        retry.at > now ||
        this.active.has(conversation) ||
        this.store.unfinished(conversation)
      )
        continue;
      this.settled.delete(conversation);
      const task = this.transcriptCatchUp(conversation, signal)
        .then((complete) => {
          if (!complete) this.queueTranscript(conversation);
        })
        .catch((error: unknown) => {
          if (signal.aborted) return;
          if (error instanceof TranscriptUnavailable) {
            // Keep the mapping and cursor; the next request re-anchors.
            if (!this.unavailable.has(conversation))
              this.log.warn(
                "Transcript unavailable; background catch-up stopped",
              );
            this.unavailable.add(conversation);
            return;
          }
          if (!retry.attempts)
            this.log.warn("Transcript catch-up failed; retrying with backoff");
          // The cursor stays put, so a later read resumes without a gap.
          this.settled.set(conversation, {
            attempts: retry.attempts + 1,
            at:
              Date.now() + Math.min(retryCeilingMs, 1000 * 2 ** retry.attempts),
          });
        })
        .finally(() => {
          this.active.delete(conversation);
        });
      this.active.set(conversation, task);
      tasks.push(task);
    }
    await Promise.all(tasks);
  }

  /** False means another writer changed the thread; read it again. */
  private async transcriptCatchUp(conversation: string, shutdown: AbortSignal) {
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
                },
              ]
            : [],
      }) !== undefined
    );
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
  ): Promise<(Transcript & { gap?: true }) | undefined> {
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
    return from === undefined ? anchored : { ...anchored, gap: true };
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
      const timeout = AbortSignal.timeout(this.config.turnTimeoutMs);
      this.cancellations.set(job.id, cancellation);
      const signal = AbortSignal.any([shutdown, cancellation.signal, timeout]);
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
      let session: string | undefined;
      let from: string | undefined;
      let transcript: Transcript | undefined;
      let keep = 0;
      const reply = (text: string, complete: boolean) => {
        if (!this.slack.react) return text;
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
        return parsed.text;
      };
      try {
        try {
          signal.throwIfAborted();
          session = this.store.session(job.conversation);
          let text = job.text;
          if (!session) {
            const before = job.eventId.slice(job.channel.length + 1);
            // Roots (including scheduled runs) have no earlier thread messages.
            if (this.config.threadContext && before !== job.thread) {
              if (!this.slack.threadContext)
                throw new ThreadContextUnavailable();
              text = withThreadContext(
                text,
                await this.slack.threadContext({
                  channel: job.channel,
                  thread: job.thread,
                  before,
                  user: job.user,
                  botUser: this.identity.user,
                  appId: this.config.slack.appId,
                  team: this.identity.team,
                  signal,
                }),
              );
              signal.throwIfAborted();
            }
            session = await this.backend.createSession({
              key: job.conversation,
              title: `${botDisplayName(this.config)} (slack ${job.channel})`,
              signal,
            });
            // A new session's transcript starts with this turn.
            this.store.saveSession(
              job.conversation,
              session,
              this.backend.transcript ? "" : undefined,
            );
          }
          signal.throwIfAborted();
          this.unavailable.delete(job.conversation);
          from = await this.transcriptFrom(job.conversation, session, signal);
          signal.throwIfAborted();
          const prompt = this.slack.react
            ? `${reactionInstructions}\n\nUser message:\n${text}`
            : text;
          activity = await this.activity.start(job, session, signal, shutdown);
          const streamed = await this.backend.prompt(
            session,
            prompt,
            signal,
            (text) => live.push(reply(text, false)),
          );
          signal.throwIfAborted();
          // The prompt reply is this request's own text: only it can react.
          const own = reply(streamed, true);
          if (this.backend.transcript)
            transcript = await this.finalTranscript(session, from, signal);
          signal.throwIfAborted();
          // Settled history covers every public reply since the last delivery.
          // The streamed copy is used only for a mapping without any cursor.
          const answer = transcript ? this.transcriptText(transcript) : own;
          // Unread or unsettled text is never posted without its cursor.
          const deferred = transcript
            ? transcript.pending && !answer.trim()
            : from !== undefined;
          if (deferred || transcript?.pending)
            this.queueTranscript(job.conversation);
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
          activity?.cancel();
          this.log.warn({ job: job.id }, "Agent request failed or timed out");
          failure = cancellation.signal.aborted
            ? "cancelled"
            : shutdown.aborted
              ? "interrupted"
              : timeout.aborted
                ? "timeout"
                : error instanceof ThreadContextUnavailable
                  ? "context"
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
              this.queueTranscript(job.conversation);
            const text = transcript ? this.transcriptText(transcript) : "";
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
            ...(transcript
              ? { transcript: { from, cursor: transcript.cursor } }
              : {}),
          });
        } catch (error) {
          if (!(error instanceof TranscriptConflict)) throw error;
          // Another writer moved the cursor: catch-up delivers from there.
          failure = "history";
          output = this.store.respond(job.id, [failureText(failure)], failure);
          this.queueTranscript(job.conversation);
        }
        failure = this.store.failure(job.id);
      } finally {
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
      this.store.finish(job.id);
    } catch {
      this.log.warn({ job: job.id }, "Slack delivery failed");
      if (job.attempts >= 7) this.store.finish(job.id, "failed");
      else
        this.store.retry(
          job.id,
          Date.now() + Math.min(60_000, 1000 * 2 ** job.attempts),
        );
    }
  }

  async close() {
    await this.activity.close();
  }
}
