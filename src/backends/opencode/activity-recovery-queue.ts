import type { SessionLogItem } from "@opencode/client";
import {
  type ActivityIncarnation,
  type EarlierCallRange,
  callPrecedesStart,
  openedInWindow,
} from "./activity-call-evidence";
import {
  ActivityNamingEvidence,
  type HeldNames,
  type NamingProof,
  type NamingSegment,
  type TimedProof,
  bindName,
  rememberDrop,
} from "./activity-naming-evidence";
import {
  ActivityLifecycleBuffer,
  ActivityReplayGap,
  isSettled,
  maxActivityGapSlots,
  nativeActivityTime,
  recoverFrames,
} from "./activity-replay-gap";
import { boundarySeq } from "./crew-executions";

export type { NamingProof } from "./activity-naming-evidence";

type Event = { type: string; data: { sessionID: string }; created?: unknown };

const startType = "session.execution.started";

export type QueuedPacket<E extends Event> = {
  event: E;
  at: number;
  order: number;
  reused?: true;
};

type Segment<E extends Event> = NamingSegment & {
  frames: QueuedPacket<E>[];
  first: {
    type: E["type"];
    at: number;
    order: number;
    seq: number | undefined;
    created: number | undefined;
    late?: true;
    reused?: true;
  };
  floor: number;
  earlier?: readonly EarlierCallRange[];
  expires: number;
  boundaryOrder?: number;
  gap?: ActivityReplayGap;
  // Recovery consumes gap entries in place; keep their reserved count.
  slots: number;
  bytes: number;
};

export type PendingActivity<E extends Event> = HeldNames & {
  segments: Segment<E>[];
  lifecycle: ActivityLifecycleBuffer;
  lifecycleSeq?: number;
  floor: number;
  earlier?: readonly EarlierCallRange[];
  expires: number;
  needsStart: boolean;
  slots: number;
  advanced?: true;
  draining?: true;
  unprovenDrain?: true;
  postLoss?: true;
  closing?: true;
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

type Removal<E extends Event> = {
  start(id: string, order: number, nativeStart?: number): void;
  candidate(id: string, pending: PendingActivity<E>, headOnly?: true): void;
};

export class ActivityRecoveryQueues<E extends Event> {
  private readonly queues = new Map<string, PendingActivity<E>>();
  private readonly evidence: ActivityNamingEvidence;
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
    private readonly removed?: Removal<E>,
  ) {
    this.evidence = new ActivityNamingEvidence(limits.pending);
  }

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

        this.closeCandidate(...oldest);
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
    this.routeProof(pending, { ...proof, seenAt: this.now() });
  }

  private routeProof(pending: PendingActivity<E>, proof: TimedProof) {
    if (proof.scope?.active === false) {
      return;
    }

    const segment = pending.segments.find(
      (segment) =>
        segment.first.type === startType &&
        openedInWindow(proof.order, proof.timing.created, this.window(segment)),
    );

    if (segment) {
      if (
        segment === pending.segments[0] &&
        pending.unprovenDrain &&
        (proof.seenAt >= segment.expires ||
          !callPrecedesStart(proof.timing.created, segment.first.created))
      ) {
        // The successor may be eligible even when the published head is not.
        this.evidence.hold(pending, proof);
      } else {
        this.offerSegment(segment, proof);
      }
    } else if (
      proof.order >
        (pending.segments.findLast(({ first }) => first.type === startType)
          ?.first.order ?? pending.floor) ||
      (pending.segments.length === 0 &&
        openedInWindow(proof.order, proof.timing.created, {
          after: pending.floor,
          through: Infinity,
          ...(pending.earlier && { earlier: pending.earlier }),
        }))
    ) {
      this.evidence.hold(pending, proof);
    }
  }

  public window({ floor, first, earlier }: Segment<E>) {
    return { after: floor, through: first.order, ...(earlier && { earlier }) };
  }

  private offerSegment(segment: Segment<E>, proof: TimedProof) {
    if (proof.seenAt >= segment.expires || proof.scope?.active === false) {
      return;
    }

    if (callPrecedesStart(proof.timing.created, segment.first.created)) {
      bindName(segment, proof);
    } else {
      // An in-time name can expose detached output without ever proving a link.
      segment.witness ??= proof;
    }
  }

  public hasProofFrom(pending: PendingActivity<E>, session: string) {
    return (
      pending.provisional.some((proof) => proof.session === session) ||
      pending.segments.some(
        ({ proofs, witness }) =>
          witness?.session === session ||
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
    const witness = segment?.witness;
    const scope = first ? first.scope : inferredScope;

    const overflow =
      segment?.proofOverflow === true ||
      segment?.droppedProofScopes?.has(scope) === true;

    return {
      first,
      witness: witness && accepts(witness) ? witness : undefined,
      ambiguous: overflow || proofs.length > 1,
      detached: overflow || proofs.some(({ log }) => log !== first?.log),
    };
  }

  public discard(id: string, keepAmbiguity = false) {
    const pending = this.peek(id);

    if (pending) {
      if (keepAmbiguity) {
        this.evidence.discard(id, pending);
      }

      this.queues.delete(id);
      pending.read?.abort();
      this.removed?.candidate(id, pending);

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
    this.evidence.reset();
  }

  public fence(scope: ActivityIncarnation) {
    this.evidence.fence(scope);

    for (const pending of this.queues.values()) {
      pending.droppedProofs?.delete(scope);

      for (const segment of pending.segments) {
        segment.droppedProofScopes?.delete(scope);
      }
    }
  }

  public expire() {
    const now = this.now();

    for (const [id, pending] of this.queues) {
      if (this.expires(pending) <= now) {
        this.schedule(id);
      }
    }
  }

  private admitReady(id: string) {
    const pending = this.peek(id);

    if (!pending || this.expires(pending) > this.now()) {
      this.admit(id);

      return;
    }

    const head = pending.segments[0];

    // Publish known names and post-loss output before releasing an expired head.
    if (head && (pending.postLoss || head.proofs.length > 0 || head.witness)) {
      this.admit(id);

      if (this.peek(id) !== pending || pending.draining) {
        return;
      }

      if (pending.segments[0] !== head) {
        if (pending.segments.length === 0 && pending.provisional.length === 0) {
          this.discard(id, true);
        }

        return;
      }
    }

    // Timeouts release the oldest segment only; explicit budgets close the candidate.
    if (pending.segments.length > 1) {
      this.removed?.candidate(id, pending, true);
      this.skip(id, pending);
    } else {
      this.discard(id, true);
    }
  }

  private closeCandidate(id: string, pending: PendingActivity<E>) {
    if (pending.postLoss && !pending.closing) {
      pending.closing = true;

      // Make retained output visible before freeing the candidate's slot.
      while (this.peek(id) === pending && pending.segments.length > 0) {
        const count = pending.segments.length;
        this.admit(id);

        if (pending.segments.length >= count) {
          break;
        }
      }
    }

    if (this.peek(id) === pending) {
      this.discard(id, true);
    }
  }

  public deadline(pending: PendingActivity<E>) {
    return pending.segments[0]?.expires ?? pending.expires;
  }

  public closed(pending: PendingActivity<E>) {
    return (
      pending.closing === true ||
      (pending.postLoss && this.deadline(pending) <= this.now())
    );
  }

  private expires(pending: PendingActivity<E>) {
    // Keep bounded names and ancestry while awaiting a start.
    // Buffered transcripts still expire as before.
    return pending.draining ||
      (pending.segments.length === 0 && pending.provisional.length > 0)
      ? Infinity
      : this.deadline(pending);
  }

  private armExpiry() {
    let earliest = Infinity;

    for (const pending of this.queues.values()) {
      earliest = Math.min(earliest, this.expires(pending));
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
      if (pending.lifecycle.lost && pending.postLoss && segment) {
        (segment.gap ??= new ActivityReplayGap()).incomplete = true;

        if (!pending.draining) {
          this.closeCandidate(id, pending);
        }
      }

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
          created: nativeActivityTime(packet.event),
          // This only removes the untimed shortcut to freshness.
          ...(start && this.deadline(pending) <= this.now() && { late: true }),
          ...(packet.reused && { reused: true }),
        },
        floor,
        ...(!segment && pending.earlier && { earlier: pending.earlier }),
        expires: start ? at + this.limits.ttl : pending.expires,
        frames: [],
        proofs: [],
        bytes: 0,
        slots: 0,
      };
      pending.segments.push(segment);
      pending.needsStart = false;
      delete pending.earlier;

      if (start) {
        const opened = segment;
        this.evidence.bindDrops(id, pending, opened, floor, order);

        pending.provisional = pending.provisional.filter((proof) => {
          if (
            proof.order > order ||
            (proof.order <= floor && pending.segments.length > 1)
          ) {
            return true;
          }

          if (
            openedInWindow(
              proof.order,
              proof.timing.created,
              this.window(opened),
            )
          ) {
            this.offerSegment(opened, proof);
          }

          return false;
        });
      }

      this.armExpiry();
    }

    // Only the published segment bypasses the candidate byte budget.
    const published = pending.draining && pending.segments[0] === segment;

    const bytes =
      lifecycle || published
        ? 0
        : Buffer.byteLength(JSON.stringify(packet.event.data));

    if (lifecycle || published || this.bytes + bytes <= this.limits.bytes) {
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
        this.admitReady(next);
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

    if (hooks.preserveProofs) {
      pending.unprovenDrain = true;
    }

    if (pending.lifecycle.lost && !pending.closing) {
      hooks.lost();
    } else if (
      !pending.closing &&
      segment.gap?.slots.size &&
      this.activeReads < this.maxReads
    ) {
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
    delete pending.draining;
    delete pending.unprovenDrain;

    if (segment) {
      this.bytes -= segment.bytes;
      this.releaseSlots(pending, segment);

      if (preserve) {
        this.preserveNames(id, pending, segment);
      } else if (segment.first.type === startType) {
        pending.floor = segment.first.order;
      }
    }

    pending.advanced = true;
    pending.needsStart = pending.segments.length === 0;

    if (
      !preserve &&
      pending.segments.length === 0 &&
      pending.provisional.length === 0
    ) {
      this.discard(id, true);
    } else if (!pending.closing) {
      if (pending.segments.length === 0) {
        pending.expires = this.now() + this.limits.ttl;
      }

      this.armExpiry();
      this.schedule(id);
    }
  }

  private preserveNames(
    id: string,
    pending: PendingActivity<E>,
    old: Segment<E>,
  ) {
    const { first } = old;
    const next = pending.segments[0];

    const retiredAt =
      pending.postLoss &&
      !pending.closing &&
      first.type === startType &&
      this.now() >= old.expires
        ? first.created
        : undefined;

    let earlier = old.earlier;

    if (retiredAt !== undefined) {
      this.removed?.start(id, first.order, retiredAt);

      // Native time must exclude a held call from every range it overlapped.
      // The normal floor stays at the released start.
      earlier = [
        ...(earlier?.map((band) => ({
          ...band,
          nativeStart: Math.max(band.nativeStart, retiredAt),
        })) ?? []),
        { after: old.floor, through: first.order, nativeStart: retiredAt },
      ];
    }

    const floor = retiredAt === undefined ? old.floor : first.order;

    if (next) {
      next.floor = floor;

      if (earlier) {
        next.earlier = earlier;
      }

      if (retiredAt === undefined && old.proofOverflow) {
        next.proofOverflow = true;
      }

      for (const scope of old.droppedProofScopes ?? []) {
        (next.droppedProofScopes ??= new Set()).add(scope);
      }
    } else {
      pending.floor = floor;

      if (earlier) {
        pending.earlier = earlier;
      }

      for (const scope of old.droppedProofScopes ?? []) {
        rememberDrop(pending, scope, {
          first: old.floor + 1,
          last: old.first.order,
        });
      }

      if (retiredAt === undefined && old.proofOverflow) {
        for (const { scope, order } of old.proofs) {
          rememberDrop(pending, scope, { first: order, last: order });
        }
      }
    }

    const held = pending.provisional.filter(
      ({ order }) => order <= old.first.order,
    );

    pending.provisional = pending.provisional.filter(
      ({ order }) => order > old.first.order,
    );

    for (const proof of [
      ...old.proofs,
      ...(old.witness ? [old.witness] : []),
      ...held,
    ]) {
      // Moving a witnessed name to a successor is not a new proof arrival.
      this.routeProof(pending, proof);
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

    if (!complete || (pending.postLoss && pending.lifecycle.lost)) {
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
