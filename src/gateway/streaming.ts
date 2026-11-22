import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import type { SlackDelivery } from "./ports";
import { chunks } from "./routing";
import { type ReplyChunk, replyText } from "../shared/slack-format";
import type { Job, Store } from "./store";

export type LiveReplyOptions = {
  allowed?: () => boolean;
  intervalMs?: number;
  waiting?: { delayMs: number | null; intervalMs: number; name: string };
  phrase?: (name: string, index: number) => string;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
};

/** Coalesce text snapshots; no network wait in the backend's event callback. */
export class LiveReply {
  private pending: string | undefined;
  private task: Promise<void> | undefined;
  private readonly stop = new AbortController();
  private readonly signal: AbortSignal;
  private disabled = false;
  private nextWrite = 0;
  private readonly shown = new Map<number, string>();
  private hasText = false;
  private held = false;
  private readonly waitingStop = new AbortController();
  private readonly waitingTask: Promise<void>;
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly intervalMs: number;
  private readonly allowed: () => boolean;

  constructor(
    private readonly job: Job,
    private readonly store: Store,
    private readonly slack: SlackDelivery,
    signal: AbortSignal,
    private readonly log: Logger,
    options: LiveReplyOptions = {},
  ) {
    this.signal = AbortSignal.any([signal, this.stop.signal]);
    this.intervalMs = options.intervalMs ?? 1500;
    this.allowed = options.allowed ?? (() => true);
    this.wait =
      options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
    this.waitingTask = this.waiting(options).catch(() => {
      if (!this.signal.aborted && !this.hasText)
        this.log.warn({ job: job.id }, "Waiting feedback stopped");
    });
  }

  readonly push = (text: string) => {
    if (!text.trim()) return;
    this.hasText = true;
    this.waitingStop.abort();
    if (this.held) return;
    this.enqueue(text);
  };

  /** Stop waiting feedback for a turn that posts nothing; later text still shows. */
  quiet() {
    this.hasText = true;
    this.waitingStop.abort();
  }

  /** Confirm a cancellable notice before its opt-out timer can start. */
  async announce(text: string) {
    this.held = true;
    this.hasText = true;
    this.waitingStop.abort();
    await this.task;
    this.signal.throwIfAborted();
    if (!this.allowed()) throw new Error("Delivery access denied");
    if (!this.slack.update || !this.slack.remove || this.disabled)
      throw new Error("Cancellable maintenance notices unavailable");
    const preview = this.store
      .previews(this.job.id)
      .find(({ part }) => part === 0);
    if (
      !preview ||
      (await this.slack.update(
        this.job.channel,
        preview.ts,
        text,
        this.job.id,
      )) === false
    ) {
      if (preview) this.store.removePreview(this.job.id, 0);
      const ts = await this.slack.post(
        this.job.channel,
        this.job.thread,
        text,
        this.job.id,
      );
      if (!ts) throw new Error("Maintenance notice delivery unconfirmed");
      this.store.savePreview(this.job.id, 0, ts);
    }
    this.signal.throwIfAborted();
    this.shown.set(0, text);
  }

  resume() {
    this.held = false;
  }

  private enqueue(text: string) {
    if (
      this.disabled ||
      this.signal.aborted ||
      !this.slack.update ||
      !this.slack.remove
    )
      return;
    this.pending = text;
    if (this.task !== undefined) return;
    this.task = this.flush()
      .catch(() => {
        if (!this.signal.aborted)
          this.log.warn(
            { job: this.job.id },
            "Live Slack delivery stopped; final reply will be retried",
          );
        this.disabled = true;
      })
      .finally(() => {
        this.task = undefined;
        if (this.pending !== undefined) this.enqueue(this.pending);
      });
  }

  private async waiting(options: LiveReplyOptions) {
    const settings = options.waiting;
    if (
      !settings ||
      settings.delayMs === null ||
      !this.slack.update ||
      !this.slack.remove
    )
      return;
    const signal = AbortSignal.any([this.signal, this.waitingStop.signal]);
    await this.wait(settings.delayMs, signal);
    let index = 0;
    while (!signal.aborted && !this.hasText && !this.disabled) {
      this.enqueue(
        options.phrase?.(settings.name, index++) ??
          `${settings.name} is working…`,
      );
      await this.wait(settings.intervalMs, signal);
    }
  }

  private async flush() {
    while (this.pending !== undefined && !this.signal.aborted) {
      const wait = this.nextWrite - Date.now();
      if (wait > 0) await this.wait(wait, this.signal);
      this.signal.throwIfAborted();
      const text = this.pending;
      this.pending = undefined;
      if (text === undefined) continue;
      const previews = new Map(
        this.store.previews(this.job.id).map(({ part, ts }) => [part, ts]),
      );
      // Classify the whole cleaned snapshot once, then deliver each chunk
      // with its own content; the transport never reparses a chunk.
      const parts: ReplyChunk[] =
        this.slack.prepareReply?.(text) ?? chunks(text);
      for (let i = 0; i < parts.length; i++) {
        this.signal.throwIfAborted();
        if (!this.allowed()) throw new Error("Delivery access denied");
        const part = parts[i];
        if (part === undefined) continue;
        const body = replyText(part);
        const content = typeof part === "string" ? undefined : part.content;
        const key =
          typeof part === "string"
            ? part
            : JSON.stringify({ text: body, content });
        if (this.shown.get(i) === key) continue;
        const ts = previews.get(i);
        if (
          !ts ||
          (await this.slack.update?.(
            this.job.channel,
            ts,
            body,
            i === 0 ? this.job.id : undefined,
            content,
          )) === false
        ) {
          if (ts) this.store.removePreview(this.job.id, i);
          const created = await this.slack.post(
            this.job.channel,
            this.job.thread,
            body,
            i === 0 ? this.job.id : undefined,
            undefined,
            content,
          );
          if (!created)
            throw new Error("Slack did not return a message timestamp");
          this.store.savePreview(this.job.id, i, created);
        }
        this.shown.set(i, key);
        this.nextWrite = Date.now() + this.intervalMs;
        // Respect channel posting limits even when a snapshot spans messages.
        if (this.intervalMs > 0 && i + 1 < parts.length)
          await this.wait(this.intervalMs, this.signal);
      }
    }
  }

  async close() {
    this.stop.abort();
    this.waitingStop.abort();
    await this.task;
    await this.waitingTask;
  }
}
