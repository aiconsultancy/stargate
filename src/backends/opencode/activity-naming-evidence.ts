import type { TurnActivityLog } from "../backend";
import type { ActivityIncarnation, CallTiming } from "./activity-call-evidence";

export type NamingProof = {
  session: string;
  log: TurnActivityLog;
  callId: string;
  order: number;
  scope?: ActivityIncarnation;
  markAttribution?: (at: number, uncertain: boolean) => void;
  timing: CallTiming;
};

export type TimedProof = NamingProof & { seenAt: number };

type CallRange = { first: number; last: number };

type ProofScope = ActivityIncarnation | undefined;

type Dropped = Map<ProofScope, CallRange>;

export type NamingSegment = {
  proofs: TimedProof[];
  witness?: TimedProof;
  proofOverflow?: true;
  droppedProofScopes?: Set<ProofScope>;
};

export type HeldNames = {
  provisional: TimedProof[];
  droppedProofs?: Dropped;
};

export function rememberDrop(
  held: HeldNames,
  scope: ProofScope,
  range: CallRange,
) {
  held.droppedProofs ??= new Map();
  held.droppedProofs.set(scope, span(held.droppedProofs.get(scope), range));
}

function span(current: CallRange | undefined, next: CallRange): CallRange {
  return {
    first: Math.min(current?.first ?? next.first, next.first),
    last: Math.max(current?.last ?? next.last, next.last),
  };
}

export function bindName(segment: NamingSegment, proof: TimedProof) {
  // Never turn ambiguity into certainty by evicting a bound competitor.
  if (segment.proofs.length < 2) {
    segment.proofs.push(proof);
    segment.proofs.sort((left, right) => left.order - right.order);
  } else {
    segment.proofOverflow = true;
  }
}

export class ActivityNamingEvidence {
  // Defaults allow 512 discarded ranges per scope, separate from call evidence.
  // One collector's 50 crew contexts can hold up to 25,600 such ranges.
  private readonly discarded = new Map<ProofScope, Map<bigint, CallRange>>();

  public constructor(private readonly limit: number) {}

  public hold(held: HeldNames, proof: TimedProof) {
    if (held.provisional.length >= this.limit) {
      const evicted = held.provisional.shift();

      if (evicted) {
        rememberDrop(held, evicted.scope, {
          first: evicted.order,
          last: evicted.order,
        });
      }
    }

    held.provisional.push(proof);
  }

  public discard(id: string, held: HeldNames) {
    for (const { scope, order } of held.provisional) {
      rememberDrop(held, scope, { first: order, last: order });
    }

    const key = this.bucket(id);

    for (const [scope, range] of held.droppedProofs ?? []) {
      const buckets = this.discarded.get(scope) ?? new Map<bigint, CallRange>();

      buckets.set(key, span(buckets.get(key), range));
      this.discarded.set(scope, buckets);
    }
  }

  public bindDrops(
    id: string,
    held: HeldNames,
    segment: NamingSegment,
    after: number,
    through: number,
  ) {
    const bucket = this.bucket(id);

    const mark = (scope: ProofScope, range: CallRange | undefined) => {
      if (range && after < range.last && range.first <= through) {
        (segment.droppedProofScopes ??= new Set()).add(scope);
      }
    };

    // Dropping a provisional hint may remove a competitor, not prove a match.
    for (const [scope, range] of held.droppedProofs ?? []) {
      mark(scope, range);

      if (range.last <= through) {
        held.droppedProofs?.delete(scope);
      }
    }

    for (const [scope, buckets] of this.discarded) {
      mark(scope, buckets.get(bucket));
    }
  }

  public reset() {
    this.discarded.clear();
  }

  public fence(scope: ActivityIncarnation) {
    this.discarded.delete(scope);
  }

  private bucket(id: string) {
    // A collision adds uncertainty; it cannot turn it into a definite match.
    return Bun.hash(id, 0n) % BigInt(Math.max(1, this.limit * 4));
  }
}
