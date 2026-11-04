import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import type { AgentBackend } from "./backend";
import type { BotConfig } from "./config";
import { botKey, chunks, type Identity, routeEvent } from "./routing";
import type { Job, Store } from "./store";

export interface SlackDelivery {
  post(channel: string, thread: string, text: string): Promise<void>;
}

export class Gateway {
  private readonly active = new Map<string, Promise<void>>();
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
      !this.config.access.users.includes(job.user) ||
      !this.config.access.channels.includes(job.channel)
    ) {
      this.store.finish(job.id, "failed");
      return;
    }
    let output: string[];
    if (job.status === "queued") {
      this.store.running(job.id);
      const signal = AbortSignal.any([
        shutdown,
        AbortSignal.timeout(this.config.turnTimeoutMs),
      ]);
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
        output = chunks(await this.backend.prompt(session, job.text, signal));
      } catch {
        this.log.warn({ job: job.id }, "Agent request failed or timed out");
        output = [
          "Pogo could not finish this request. Work may have run; it was not repeated. Check the agent before trying again.",
        ];
      }
      this.store.respond(job.id, output);
    } else {
      output = JSON.parse(job.response ?? "[]") as string[];
    }
    try {
      for (let i = job.sent; i < output.length; i++) {
        if (shutdown.aborted) return;
        const text = output[i];
        if (text === undefined) continue;
        await this.slack.post(job.channel, job.thread, text);
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
