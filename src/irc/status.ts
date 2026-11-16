import { waitingPhrase } from "../waiting";

export type StatusResult =
  | { kind: "ok" }
  | { kind: "unavailable" }
  | { kind: "rejected" }
  | { kind: "rate-limited"; retryAfterMs: number };

export type StatusTiming = {
  intervalMs: number;
  windowMs: number;
  limit: number;
  retryMs: number;
  shutdownMs: number;
};

const defaults: StatusTiming = {
  intervalMs: 15_000,
  windowMs: 120_001,
  limit: 10,
  retryMs: 1000,
  shutdownMs: 140_000,
};

type Attempt = {
  generation: number;
  revision: number;
  value: string | undefined;
};

/** Nick-wide cosmetic state. Only configured names and fixed phrases enter it. */
export class IrcStatus {
  private readonly name: string;
  private readonly timing: StatusTiming;
  private active = 0;
  private online = false;
  private closing = false;
  private stopped = false;
  private generation = 0;
  private revision = 0;
  private clearPending = false;
  private dirty = false;
  private maxValueBytes = 344;
  private phrase = 0;
  private lastNonclearAt = Number.NEGATIVE_INFINITY;
  private backoffUntil = 0;
  private readonly attempts: number[] = [];
  private inFlight: Attempt | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private finishShutdown: (() => void) | undefined;

  constructor(
    name: string,
    private readonly publish: (
      value: string | undefined,
      guard: () => boolean,
    ) => Promise<StatusResult>,
    timing: Partial<StatusTiming> = {},
  ) {
    this.name = Array.from(name.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " "))
      .slice(0, 80)
      .join("")
      .trim();
    this.timing = { ...defaults };
    for (const key of Object.keys(defaults) as (keyof StatusTiming)[]) {
      const value = timing[key];
      if (value !== undefined && Number.isFinite(value) && value >= 1) {
        this.timing[key] = Math.min(Math.floor(value), 2_147_483_647);
      }
    }
  }

  /** Call only after registration on a connection supporting status metadata. */
  connected(maxValueBytes?: number): void {
    if (this.stopped) return;
    this.generation++;
    this.revision++;
    this.online = true;
    this.maxValueBytes =
      maxValueBytes === undefined
        ? 344
        : Number.isFinite(maxValueBytes)
          ? Math.max(0, Math.min(344, Math.floor(maxValueBytes)))
          : 0;
    // Always-on/multiclient servers can retain another connection's old value.
    this.clearPending = true;
    this.wake();
  }

  disconnected(): void {
    if (this.closing) {
      this.stop();
      return;
    }
    this.online = false;
    this.generation++;
    this.revision++;
    this.cancelWake();
  }

  begin(): () => void {
    if (this.closing || this.stopped) return () => {};
    this.active++;
    this.wake();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.active--;
      if (this.active === 0) {
        this.revision++;
        if (this.dirty) this.clearPending = true;
      }
      this.wake();
    };
  }

  /** Best-effort acknowledged clear before QUIT, with a bounded deadline. */
  shutdown(): Promise<void> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;
    this.closing = true;
    this.revision++;
    if (this.dirty) this.clearPending = true;
    this.shutdownPromise = new Promise<void>((resolve) => {
      this.finishShutdown = resolve;
    });
    this.shutdownTimer = setTimeout(() => this.stop(), this.timing.shutdownMs);
    this.wake();
    return this.shutdownPromise;
  }

  private cancelWake(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private wake(delay = 0): void {
    this.cancelWake();
    if (this.stopped) return;
    if (this.closing && !this.clearPending && !this.inFlight) {
      this.stop();
      return;
    }
    if (!this.online || this.inFlight) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.pump();
      },
      Math.min(Math.max(0, delay), 2_147_483_647),
    );
  }

  private pump(): void {
    if (this.stopped || !this.online || this.inFlight) return;
    const clear = this.clearPending;
    if (!clear && (this.closing || this.active === 0)) return;
    const value = clear ? undefined : this.busyValue();
    if (!clear && value === undefined) return;
    const now = Date.now();
    while (
      this.attempts.length > 0 &&
      (this.attempts[0] ?? now) + this.timing.windowMs <= now
    ) {
      this.attempts.shift();
    }
    // Reserve the last SET attempt for clearing, including missing-key deletes.
    const capacity = this.timing.limit - (clear ? 0 : 1);
    if (capacity === 0) return;
    let due = Math.max(
      this.backoffUntil,
      clear ? 0 : this.lastNonclearAt + this.timing.intervalMs,
    );
    if (this.attempts.length >= capacity) {
      const oldest = this.attempts[this.attempts.length - capacity];
      if (oldest !== undefined) {
        due = Math.max(due, oldest + this.timing.windowMs);
      }
    }
    if (due > now) {
      this.wake(due - now);
      return;
    }
    const attempt: Attempt = {
      generation: this.generation,
      revision: this.revision,
      value,
    };
    this.inFlight = attempt;
    this.attempts.push(now);
    if (!clear) {
      // A lost ACK can still mean a write. Keep cleanup until a clear is ACKed.
      this.dirty = true;
      this.lastNonclearAt = now;
      this.phrase++;
    }
    void this.send(attempt);
  }

  private valid(attempt: Attempt): boolean {
    return (
      !this.stopped &&
      this.online &&
      this.generation === attempt.generation &&
      this.inFlight === attempt &&
      (attempt.value === undefined
        ? this.clearPending
        : !this.closing &&
          !this.clearPending &&
          this.active > 0 &&
          this.revision === attempt.revision)
    );
  }

  private async send(attempt: Attempt): Promise<void> {
    let result: StatusResult;
    try {
      result = await this.publish(attempt.value, () => this.valid(attempt));
    } catch {
      result = { kind: "unavailable" };
    }
    this.inFlight = undefined;
    if (this.stopped) return;
    // The transport may queue a write. Charging through its reply is conservative
    // for both the rolling quota and spacing between actual nonclear writes.
    const settledAt = Date.now();
    this.attempts[this.attempts.length - 1] = settledAt;
    if (attempt.value !== undefined) this.lastNonclearAt = settledAt;
    if (result.kind === "rate-limited") {
      const retry = Number.isFinite(result.retryAfterMs)
        ? Math.max(this.timing.retryMs, result.retryAfterMs)
        : this.timing.retryMs;
      this.backoffUntil = Math.max(this.backoffUntil, settledAt + retry);
    }
    if (attempt.generation !== this.generation) {
      this.wake();
      return;
    }
    if (result.kind === "ok") {
      if (attempt.value === undefined) {
        this.clearPending = false;
        this.dirty = false;
      }
    } else if (result.kind !== "rate-limited") {
      this.backoffUntil = Math.max(
        this.backoffUntil,
        settledAt + this.timing.retryMs,
      );
    }
    this.wake();
  }

  private busyValue(): string | undefined {
    const suffix = waitingPhrase("", this.phrase);
    const budget = this.maxValueBytes - Buffer.byteLength(suffix);
    let name = "";
    let bytes = 0;
    for (const character of this.name) {
      bytes += Buffer.byteLength(character);
      if (bytes > budget) break;
      name += character;
    }
    return name.trim() ? waitingPhrase(name.trimEnd(), this.phrase) : undefined;
  }

  private stop(): void {
    this.stopped = true;
    this.online = false;
    this.generation++;
    this.cancelWake();
    if (this.shutdownTimer !== undefined) clearTimeout(this.shutdownTimer);
    this.shutdownTimer = undefined;
    this.finishShutdown?.();
    this.finishShutdown = undefined;
  }
}
