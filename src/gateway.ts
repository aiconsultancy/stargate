import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import type { AgentBackend } from "./backend";
import { cancellationTarget } from "./cancellation";
import type { BotConfig } from "./config";
import {
  parseReactionReply,
  type ReactionName,
  reactionInstructions,
} from "./reactions";
import {
  botKey,
  chunks,
  conversationKey,
  type Identity,
  isAllowedChannel,
  isAllowedUser,
  routeEvent,
} from "./routing";
import type { Job, Store } from "./store";
import { LiveReply } from "./streaming";
import { botDisplayName, resolveWaiting, waitingPhrase } from "./waiting";

export interface SlackDelivery {
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
  private readonly active = new Map<string, Promise<void>>();
  private readonly cancellations = new Map<number, AbortController>();
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
        await delay(200, undefined, { signal });
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      await Promise.all(this.active.values());
    }
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
    if (job.status === "queued") {
      if (!this.store.running(job.id)) return;
      const cancellation = new AbortController();
      this.cancellations.set(job.id, cancellation);
      const signal = AbortSignal.any([
        shutdown,
        cancellation.signal,
        AbortSignal.timeout(this.config.turnTimeoutMs),
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
          let session = this.store.session(job.conversation);
          if (!session) {
            session = await this.backend.createSession({
              key: job.conversation,
              title: `Slack ${job.channel} ${job.thread}`,
              signal,
            });
            this.store.saveSession(job.conversation, session);
          }
          signal.throwIfAborted();
          const prompt = this.slack.react
            ? `${reactionInstructions}\n\nUser message:\n${job.text}`
            : job.text;
          const answer = reply(
            await this.backend.prompt(session, prompt, signal, (text) =>
              live.push(reply(text, false)),
            ),
            true,
          );
          output = reacted && !answer.trim() ? [] : chunks(answer);
        } catch {
          this.log.warn({ job: job.id }, "Agent request failed or timed out");
          output = [
            "Pogo could not finish this request. Work may have run; it was not repeated. Check the agent before trying again.",
          ];
        }
        // A reaction-only reply has no answer to preserve until delivery settles.
        if (output.length === 0) {
          await reactionTask;
          if (!reactionDelivered)
            output = ["Pogo could not add that reaction."];
        }
        // Completion commits before awaiting preview cleanup. A late Stop cannot erase it.
        output = this.store.respond(job.id, output);
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
        if (ts) {
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
}
