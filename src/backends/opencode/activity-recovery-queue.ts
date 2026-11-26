import type { SessionLogItem } from "@opencode/client";
import type { TurnActivityLog } from "../backend";
import type { ActivityIncarnation } from "./activity-call-evidence";
import {
  ActivityLifecycleBuffer,
  ActivityReplayGap,
  isSettled,
  maxActivityGapSlots,
  recoverFrames,
} from "./activity-replay-gap";
import { boundarySeq } from "./crew-executions";

type Event = { type: string; data: { sessionID: string } };

const startType = "session.execution.started";

type CallRange = { first: number; last: number };

type ProofScope = ActivityIncarnation | undefined;

function span(current: CallRange | undefined, next: CallRange): CallRange {
  return {
    first: Math.min(current?.first ?? next.first, next.first),
    last: Math.max(current?.last ?? next.last, next.last),
  };
}

export type QueuedPacket<E extends Event> = {
  event: E;
  at: number;
  order: number;
  reused?: true;
};

export type NamingProof = {
  session: string;
  log: TurnActivityLog;
  callId: string;
  order: number;
  scope?: ActivityIncarnation;
  markAttribution?: (at: number, uncertain: boolean) => void;
  freshSession?: true;
};

type Segment<E extends Event> = {
  frames: QueuedPacket<E>[];
  first: {
    type: E["type"];
    at: number;
    order: number;
    seq: number | undefined;
    reused?: true;
  };
  floor: number;
  boundaryOrder?: number;
  gap?: ActivityReplayGap;
  // Recovery consumes gap entries in place; keep their reserved count.
  slots: number;
  bytes: number;
  proofs: NamingProof[];
  proofOverflow?: true;
  droppedProofScopes?: Set<ProofScope>;
};

export type PendingActivity<E extends Event> = {
  segments: Segment<E>[];
  lifecycle: ActivityLifecycleBuffer;
  lifecycleSeq?: number;
  floor: number;
  expires: number;
  needsStart: boolean;
  provisional: { proof: NamingProof; expires: number }[];
  droppedProofs?: Map<ProofScope, CallRange>;
  slots: number;
  advanced?: true;
  draining?: true;
  read?: AbortController;
  recovery?: Promise<void>;
};

type Drain<E extends Event> = {
  signal: AbortSignal;
  read(after: number, signal: AbortSignal): AsyncIterable<SessionLogItem>;
  accepts(event: SessionLogItem): event is SessionLogItem & E;
  owned(): boolean;
  replay(frames: QueuedPacket<E>[]): void;
  gap(): void;
  lost(): void;
  superseded(): void;
  preserveProofs?: true;
};

export const activityQueueDefaults = {
  pending: 128,
  bytes: 256 * 1024,
  ttl: 2000,
};

type Removal = {
  start(id: string, order: number): void;
  candidate(id: string): void;
};

export class ActivityRecoveryQueues<E extends Event> {
  private readonly queues = new Map<string, PendingActivity<E>>();
  // Defaults allow 512 discarded ranges per scope, separate from call evidence.
  // One collector's 50 crew contexts can hold up to 25,600 such ranges.
  private readonly discardedProofs = new Map<
    ProofScope,
    Map<bigint, CallRange>
  >();
  private activeReads = 0;
  private readonly ready = new Set<string>();
  private bytes = 0;
  private draining = false;
  private expiry: ReturnType<typeof setTimeout> | undefined;

  public constructor(
    private readonly limits: typeof activityQueueDefaults,
    private readonly now: () => number,
    private readonly maxReads: number,
    private readonly needsStart: (id: string) => boolean,
    private readonly admit: (id: string) => void,
    private readonly removed?: Removal,
  ) {}

  public entries() {
    return this.queues.entries();
  }

  public peek(id: string) {
    return this.queues.get(id);
  }

  public active(id: string) {
    const pending = this.peek(id);

    return pending?.draining ? pending : undefined;
  }

  public async settleReads() {
    await Promise.all(
      [...this.queues.values()].map(async (pending) => {
        while (pending.recovery) {
          await pending.recovery;
        }
      }),
    );
  }

  public candidate(id: string, floor = -Infinity) {
    let pending = this.peek(id);

    if (!pending) {
      while (this.queues.size >= this.limits.pending) {
        const oldest = this.entries().find(([, queued]) => !queued.draining);

        if (oldest === undefined) {
          break;
        }

        this.discard(oldest[0], true);
      }

      pending = {
        segments: [],
        lifecycle: new ActivityLifecycleBuffer(),
        floor,
        expires: this.now() + this.limits.ttl,
        needsStart: this.needsStart(id),
        provisional: [],
        slots: 0,
      };
      this.queues.set(id, pending);
      this.armExpiry();
    }

    return pending;
  }

  public offerProof(pending: PendingActivity<E>, proof: NamingProof) {
    const segment = pending.segments.find(
      ({ floor, first }) =>
        first.type === startType &&
        floor < proof.order &&
        proof.order <= first.order,
    );

    if (segment) {
      this.bind(segment, proof);
    } else if (
      proof.order >
      (pending.segments.findLast(({ first }) => first.type === startType)?.first
        .order ?? pending.floor)
    ) {
      if (pending.provisional.length >= this.limits.pending) {
        const evicted = pending.provisional.shift();

        if (evicted) {
          this.recordDrop(pending, evicted.proof);
        }
      }

      pending.provisional.push({
        proof,
        expires: this.now() + this.limits.ttl,
      });
      this.armExpiry();
    }
  }

  private recordDrop(
    pending: PendingActivity<E>,
    { scope, order }: NamingProof,
  ) {
    pending.droppedProofs ??= new Map();
    const dropped = pending.droppedProofs;
    dropped.set(
      scope,
      span(dropped.get(scope), {
        first: order,
        last: order,
      }),
    );
  }

  private expireProofs(pending: PendingActivity<E>, now: number) {
    pending.provisional = pending.provisional.filter(({ proof, expires }) => {
      if (expires > now) {
        return true;
      }

      this.recordDrop(pending, proof);

      return false;
    });
  }

  public hasProofFrom(pending: PendingActivity<E>, session: string) {
    return (
      pending.provisional.some(({ proof }) => proof.session === session) ||
      pending.segments.some(({ proofs }) =>
        proofs.some((proof) => proof.session === session),
      )
    );
  }

  public naming(
    pending: PendingActivity<E>,
    accepts: (proof: NamingProof) => boolean,
    inferredScope?: ActivityIncarnation,
  ) {
    const segment = pending.segments[0];
    const proofs = segment?.proofs.filter(accepts) ?? [];
    const first = proofs[0];
    const scope = first ? first.scope : inferredScope;

    const overflow =
      segment?.proofOverflow === true ||
      segment?.droppedProofScopes?.has(scope) === true;

    return {
      first,
      ambiguous: overflow || proofs.length > 1,
      detached: overflow || proofs.some(({ log }) => log !== first?.log),
    };
  }

  private bind(segment: Segment<E>, proof: NamingProof) {
    // Never turn ambiguity into certainty by evicting a bound competitor.
    if (segment.proofs.length < 2) {
      segment.proofs.push(proof);
      segment.proofs.sort((left, right) => left.order - right.order);
    } else {
      segment.proofOverflow = true;
    }
  }

  public discard(id: string, keepAmbiguity = false) {
    const pending = this.peek(id);

    if (pending) {
      if (keepAmbiguity) {
        for (const { proof } of pending.provisional) {
          this.recordDrop(pending, proof);
        }

        const key = this.proofBucket(id);

        for (const [scope, range] of pending.droppedProofs ?? []) {
          const buckets =
            this.discardedProofs.get(scope) ?? new Map<bigint, CallRange>();

          buckets.set(key, span(buckets.get(key), range));
          this.discardedProofs.set(scope, buckets);
        }
      }

      this.queues.delete(id);
      pending.read?.abort();
      this.removed?.candidate(id);

      for (const segment of pending.segments) {
        this.bytes -= segment.bytes;
        this.releaseSlots(pending, segment);
      }

      if (keepAmbiguity) {
        const start = pending.segments.findLast(
          ({ first }, index) =>
            (!pending.draining || index > 0) &&
            first.type === startType &&
            first.seq !== undefined,
        )?.first;

        if (start) {
          this.removed?.start(id, start.order);
        }
      }
    }
  }

  public resetDiscardedProofs() {
    this.discardedProofs.clear();
  }

  public fence(scope: ActivityIncarnation) {
    this.discardedProofs.delete(scope);

    for (const pending of this.queues.values()) {
      pending.droppedProofs?.delete(scope);

      for (const segment of pending.segments) {
        segment.droppedProofScopes?.delete(scope);
      }
    }
  }

  private proofBucket(id: string) {
    // A collision adds uncertainty; it cannot turn it into a definite match.
    return Bun.hash(id, 0n) % BigInt(Math.max(1, this.limits.pending * 4));
  }

  public expire() {
    const now = this.now();

    for (const [id, pending] of this.queues) {
      this.expireProofs(pending, now);

      if (!pending.draining && pending.expires <= now) {
        this.discard(id, true);
      }
    }
  }

  private armExpiry() {
    let earliest = Infinity;

    for (const pending of this.queues.values()) {
      earliest = Math.min(
        earliest,
        pending.provisional[0]?.expires ?? Infinity,
        pending.draining ? Infinity : pending.expires,
      );
    }

    if (!this.expiry && earliest < Infinity) {
      this.expiry = setTimeout(
        () => {
          this.expiry = undefined;
          this.expire();
          this.armExpiry();
        },
        Math.max(1, earliest - this.now()),
      );
      this.expiry.unref();
    }
  }

  private retainBoundary(pending: PendingActivity<E>, packet: QueuedPacket<E>) {
    const seq = boundarySeq(packet.event);

    if (seq !== undefined) {
      if (seq <= (pending.lifecycleSeq ?? -1)) {
        return false;
      }

      pending.lifecycleSeq = seq;
    }

    return pending.lifecycle.retain();
  }

  private bindDrops(
    id: string,
    pending: PendingActivity<E>,
    segment: Segment<E>,
  ) {
    const { floor, first } = segment;
    const bucket = this.proofBucket(id);

    const mark = (scope: ProofScope, range: CallRange | undefined) => {
      if (range && floor < range.last && range.first <= first.order) {
        (segment.droppedProofScopes ??= new Set()).add(scope);
      }
    };

    // Dropping a provisional hint may remove a competitor, not prove a match.
    for (const [scope, range] of pending.droppedProofs ?? []) {
      mark(scope, range);

      if (range.last <= first.order) {
        pending.droppedProofs?.delete(scope);
      }
    }

    for (const [scope, buckets] of this.discardedProofs) {
      mark(scope, buckets.get(bucket));
    }
  }

  public enqueue(
    id: string,
    packet: QueuedPacket<E>,
    pending = this.candidate(id),
  ) {
    const type = packet.event.type;
    const start = type === startType;

    if (pending.lifecycle.lost || (pending.needsStart && !start)) {
      return;
    }

    const terminal = isSettled(type);

    let segment = pending.segments.at(-1);

    if (!segment && terminal) {
      pending.needsStart = true;

      return;
    }

    const lifecycle = terminal || start;

    if (lifecycle && !this.retainBoundary(pending, packet)) {
      return;
    }

    const { at, order } = packet;

    if (segment && lifecycle) {
      segment.boundaryOrder ??= order;
    }

    if (!segment || start) {
      // Terminals fence transcript output, not overlapping launch calls.
      const floor =
        segment?.first.type === startType ? segment.first.order : pending.floor;

      segment = {
        first: {
          type,
          at,
          order,
          seq: boundarySeq(packet.event),
          ...(packet.reused && { reused: true }),
        },
        floor,
        frames: [],
        proofs: [],
        bytes: 0,
        slots: 0,
      };
      pending.segments.push(segment);
      pending.needsStart = false;

      if (start) {
        this.expireProofs(pending, this.now());
        this.bindDrops(id, pending, segment);

        for (const { proof } of pending.provisional) {
          if (floor < proof.order && proof.order <= order) {
            this.bind(segment, proof);
          }
        }

        pending.provisional = pending.provisional.filter(
          ({ proof }) => proof.order > order,
        );
      }
    }

    const bytes = lifecycle
      ? 0
      : Buffer.byteLength(JSON.stringify(packet.event.data));

    if (lifecycle || this.bytes + bytes <= this.limits.bytes) {
      segment.frames.push(packet);
      segment.bytes += bytes;
      this.bytes += bytes;
    } else {
      segment.gap ??= new ActivityReplayGap();
      const count = segment.gap.slots.size;
      segment.gap.omit(
        { at, order, type },
        pending.slots < maxActivityGapSlots
          ? boundarySeq(packet.event)
          : undefined,
      );
      const retained = segment.gap.slots.size - count;
      segment.slots += retained;
      pending.slots += retained;
    }

    if (!pending.draining) {
      this.schedule(id);
    }
  }

  public schedule(id: string, defer = false) {
    this.ready.add(id);

    if (defer || this.draining) {
      return;
    }

    this.draining = true;

    try {
      // Iterative, including nested admissions during replay.
      for (const next of this.ready) {
        this.ready.delete(next);
        this.admit(next);
      }
    } finally {
      this.draining = false;
    }
  }

  public skip(id: string, pending: PendingActivity<E>, stale = false) {
    if ((stale || pending.segments.length > 1) && !pending.draining) {
      const first = pending.segments[0]?.first;

      if (!stale && first?.type === startType && first.seq !== undefined) {
        this.removed?.start(id, first.order);
      }

      this.advance(id, pending);
    }
  }

  public drain(id: string, pending: PendingActivity<E>, hooks: Drain<E>) {
    const segment = pending.segments[0];

    if (!segment || pending.draining) {
      return;
    }

    pending.draining = true;

    if (pending.lifecycle.lost) {
      hooks.lost();
    } else if (segment.gap?.slots.size && this.activeReads < this.maxReads) {
      const read = new AbortController();
      pending.read = read;
      this.activeReads += 1;
      pending.recovery = this.recover(
        id,
        pending,
        segment,
        segment.gap,
        hooks,
        read,
      );
    } else {
      if (segment.gap) {
        hooks.gap();
      }

      this.handoff(id, pending, segment.frames, hooks);
    }
  }

  private handoff(
    id: string,
    pending: PendingActivity<E>,
    frames: QueuedPacket<E>[],
    hooks: Drain<E>,
  ) {
    hooks.replay(frames);

    if (this.peek(id) !== pending) {
      return;
    }

    if (pending.segments.length > 1) {
      hooks.superseded();
    }

    this.advance(id, pending, hooks.preserveProofs);
  }

  private releaseSlots(pending: PendingActivity<E>, segment: Segment<E>) {
    pending.slots -= segment.slots;
    segment.slots = 0;
  }

  private advance(id: string, pending: PendingActivity<E>, preserve?: true) {
    const segment = pending.segments.shift();

    if (segment) {
      this.bytes -= segment.bytes;
      this.releaseSlots(pending, segment);

      if (preserve) {
        this.preserveNames(pending, segment);
      } else if (segment.first.type === startType) {
        pending.floor = segment.first.order;
      }
    }

    delete pending.draining;
    pending.advanced = true;
    pending.needsStart = pending.segments.length === 0;

    if (pending.segments.length === 0 && pending.provisional.length === 0) {
      this.discard(id, true);
    } else {
      pending.expires = this.now() + this.limits.ttl;
      this.armExpiry();
      this.schedule(id);
    }
  }

  private preserveNames(pending: PendingActivity<E>, old: Segment<E>) {
    const next = pending.segments[0];

    if (next) {
      next.floor = old.floor;

      if (old.proofOverflow) {
        next.proofOverflow = true;
      }

      for (const scope of old.droppedProofScopes ?? []) {
        (next.droppedProofScopes ??= new Set()).add(scope);
      }
    } else {
      for (const scope of old.droppedProofScopes ?? []) {
        pending.droppedProofs ??= new Map();
        pending.droppedProofs.set(
          scope,
          span(pending.droppedProofs.get(scope), {
            first: old.floor + 1,
            last: old.first.order,
          }),
        );
      }

      if (old.proofOverflow) {
        for (const proof of old.proofs) {
          this.recordDrop(pending, proof);
        }
      }
    }

    for (const proof of old.proofs) {
      this.offerProof(pending, proof);
    }
  }

  private async recover(
    id: string,
    pending: PendingActivity<E>,
    segment: Segment<E>,
    gap: ActivityReplayGap,
    hooks: Drain<E>,
    read: AbortController,
  ) {
    const signal = AbortSignal.any([hooks.signal, read.signal]);
    const current = () => this.peek(id) === pending && hooks.owned();

    const { complete, index } = await recoverFrames(
      segment.frames,
      gap,
      (after) => hooks.read(after, signal),
      signal,
      (event, slot) => {
        if (
          current() &&
          !pending.lifecycle.lost &&
          hooks.accepts(event) &&
          boundarySeq(event) === slot.seq &&
          event.data.sessionID === id
        ) {
          return { event, at: slot.at, order: slot.order };
        }

        return;
      },
      (packet) => {
        hooks.replay([packet]);
      },
    );

    this.activeReads -= 1;
    delete pending.read;
    delete pending.recovery;
    this.releaseSlots(pending, segment);

    if (!current()) {
      if (this.peek(id) === pending) {
        this.discard(id);
      }

      return;
    }

    if (!complete) {
      hooks.gap();
    }

    if (pending.lifecycle.lost) {
      hooks.lost();

      return;
    }

    this.handoff(id, pending, segment.frames.slice(index), hooks);
  }

  public close() {
    this.resetDiscardedProofs();

    for (const id of this.queues.keys()) {
      this.discard(id);
    }

    this.ready.clear();
    this.bytes = 0;
    clearTimeout(this.expiry);
    this.expiry = undefined;
  }
}
