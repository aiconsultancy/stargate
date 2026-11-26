import type { TurnActivityLog } from "../backend";

export type ActivityIncarnation = { active: boolean };

type Call = { order: number; named?: true };

type OwnerCalls = { session: string; calls: Map<string, Call> };

type Range = { first: number; last: number };

type NamedCalls = { orders: Set<number>; dropped?: Range };

type Window = { except: number; after: number; through: number };

function overlaps(
  range: Range | undefined,
  { after, through, except }: Window,
) {
  if (!range) {
    return false;
  }

  const first = Math.max(after + 1, range.first);
  const last = Math.min(through, range.last);

  return first <= last && (first !== last || first !== except);
}

function extend(range: Range | undefined, { first, last }: Range) {
  return {
    first: Math.min(range?.first ?? first, first),
    last: Math.max(range?.last ?? last, last),
  };
}

function inWindow(order: number, { after, through, except }: Window) {
  return after < order && order <= through && order !== except;
}

class ScopeEvidence {
  public readonly owners = new WeakMap<TurnActivityLog, OwnerCalls>();
  private readonly pending = new Map<string, Set<number>>();
  private readonly ranges = new Map<string, Range>();
  private readonly overflow = new Map<bigint, Range>();
  private readonly named = new Map<string, Map<string, NamedCalls>>();
  private namedCount = 0;
  private saturated: Range | undefined;
  private readonly capacity: number;

  public constructor(private readonly callsPerLog: number) {
    this.capacity = Math.max(1, callsPerLog * 4);
  }

  private bucket(session: string) {
    return Bun.hash(session, 0n) % BigInt(this.capacity);
  }

  private rememberUnnamed(session: string, order: number) {
    const range = this.ranges.get(session);

    if (!range && this.ranges.size >= this.capacity) {
      const oldest = this.ranges.entries().next().value;

      if (oldest) {
        const [id, dropped] = oldest;
        const bucket = this.bucket(id);
        this.overflow.set(bucket, extend(this.overflow.get(bucket), dropped));
        this.ranges.delete(id);
      }
    }

    this.ranges.set(session, extend(range, { first: order, last: order }));
  }

  public unnamed(session: string, order: number) {
    const orders = this.pending.get(session) ?? new Set<number>();

    if (!this.pending.has(session) && this.pending.size >= this.capacity) {
      const oldest = this.pending.entries().next().value;

      if (oldest) {
        const [id, dropped] = oldest;

        for (const order of dropped) {
          this.rememberUnnamed(id, order);
        }

        this.pending.delete(id);
      }
    }

    if (orders.size >= this.callsPerLog) {
      const oldest = orders.values().next().value;

      if (oldest !== undefined) {
        this.rememberUnnamed(session, oldest);
        orders.delete(oldest);
      }
    }

    orders.add(order);
    this.pending.delete(session);
    this.pending.set(session, orders);
  }

  public identify(session: string, child: string, order: number) {
    const orders = this.pending.get(session);

    if (orders?.delete(order) && orders.size === 0) {
      this.pending.delete(session);
    }

    const range = this.ranges.get(session);

    if (range?.first === order && range.last === order) {
      this.ranges.delete(session);
    }

    const bucket = this.bucket(session);
    const overflow = this.overflow.get(bucket);

    if (overflow?.first === order && overflow.last === order) {
      this.overflow.delete(bucket);
    }

    const parents = this.named.get(child) ?? new Map<string, NamedCalls>();
    const named = parents.get(session);

    if (!named && this.namedCount >= this.capacity) {
      // Do not evict exact child identities into hash buckets. At the hard
      // Bound, withhold certainty for this scope's untracked order window.
      this.saturated = extend(this.saturated, { first: order, last: order });

      return;
    }

    const calls: NamedCalls = named ?? { orders: new Set() };

    if (calls.orders.size >= this.callsPerLog) {
      const oldest = calls.orders.values().next().value;

      if (oldest !== undefined) {
        calls.dropped = extend(calls.dropped, { first: oldest, last: oldest });
        calls.orders.delete(oldest);
      }
    }

    calls.orders.add(order);

    if (!named) {
      this.namedCount += 1;
      parents.set(session, calls);
      this.named.set(child, parents);
    }
  }

  public retire(child: string, through: number, session?: string) {
    const parents = this.named.get(child);

    if (!parents) {
      return;
    }

    for (const [parent, calls] of parents) {
      if (
        (session === undefined || parent === session) &&
        this.trim(calls, through)
      ) {
        parents.delete(parent);
        this.namedCount -= 1;
      }
    }

    if (parents.size === 0) {
      this.named.delete(child);
    }
  }

  private trim(calls: NamedCalls, through: number) {
    for (const order of calls.orders) {
      if (order <= through) {
        calls.orders.delete(order);
      }
    }

    if (calls.dropped && calls.dropped.last <= through) {
      delete calls.dropped;
    } else if (calls.dropped && calls.dropped.first <= through) {
      calls.dropped.first = through + 1;
    }

    return !calls.dropped && calls.orders.size === 0;
  }

  public competing(session: string, child: string, window: Window) {
    const named = this.named.get(child)?.get(session);

    return (
      overlaps(this.ranges.get(session), window) ||
      overlaps(this.overflow.get(this.bucket(session)), window) ||
      overlaps(named?.dropped, window) ||
      overlaps(this.saturated, window) ||
      named?.orders.values().some((order) => inWindow(order, window)) ===
        true ||
      this.pending
        .get(session)
        ?.values()
        .some((order) => inWindow(order, window)) === true
    );
  }
}

/**
 * Exact naming follows its log (128 call records per live log at the default).
 * The number of evidence-bearing live logs is not explicitly capped here.
 * Ambiguity follows the incarnation. At the default, each scope holds at most:
 * - 512 × 128 unnamed orders, plus 512 exact and 512 hashed unnamed ranges;
 * - 512 × (128 named orders + 1 dropped range), plus 1 saturation range.
 * That's 132,609 evidence records per scope, or 6,630,450 across the 50
 * contexts of one crew collector. An officer collector uses one unscoped index.
 * These counts exclude map keys and the separate candidate/replay queues.
 */
export class ActivityCallEvidence {
  // Active scopes only. The crew collector fences each retired incarnation.
  private readonly incarnations = new Map<ActivityIncarnation, ScopeEvidence>();
  private unscoped: ScopeEvidence;

  public constructor(private readonly callsPerLog: number) {
    this.unscoped = new ScopeEvidence(callsPerLog);
  }

  private scope(scope: ActivityIncarnation | undefined, create = false) {
    if (scope === undefined) {
      return this.unscoped;
    }

    if (!scope.active) {
      return;
    }

    let index = this.incarnations.get(scope);

    if (!index && create) {
      index = new ScopeEvidence(this.callsPerLog);
      this.incarnations.set(scope, index);
    }

    return index;
  }

  public open(
    session: string,
    scope: ActivityIncarnation | undefined,
    owner: TurnActivityLog,
    key: string,
    order: number,
  ) {
    const index = this.scope(scope, true);

    if (!index) {
      return;
    }

    const owned = index.owners.get(owner) ?? {
      session,
      calls: new Map<string, Call>(),
    };

    const { calls } = owned;

    if (session !== owned.session || calls.has(key)) {
      return;
    }

    if (calls.size >= this.callsPerLog) {
      const oldest = calls.keys().next().value;

      if (oldest !== undefined) {
        calls.delete(oldest);
      }
    }

    calls.set(key, { order });
    index.owners.set(owner, owned);
    index.unnamed(session, order);
  }

  public name(
    session: string,
    scope: ActivityIncarnation | undefined,
    owner: TurnActivityLog,
    key: string,
    child: string,
  ) {
    const index = this.scope(scope);
    const owned = index?.owners.get(owner);
    const call = owned?.calls.get(key);

    if (!index || owned?.session !== session || !call || call.named) {
      return null;
    }

    call.named = true;
    index.identify(session, child, call.order);

    return call.order;
  }

  public competing(
    session: string,
    scope: ActivityIncarnation | undefined,
    child: string,
    window: Window,
  ) {
    return this.scope(scope)?.competing(session, child, window) ?? false;
  }

  /** No attribution window for this child can still need these names. */
  public retire(
    session: string,
    scope: ActivityIncarnation | undefined,
    child: string,
    through: number,
  ) {
    this.scope(scope)?.retire(child, through, session);
  }

  /** A discarded start cannot establish a parent, so retire across scopes. */
  public discardStart(child: string, through: number) {
    this.unscoped.retire(child, through);

    for (const index of this.incarnations.values()) {
      index.retire(child, through);
    }
  }

  public fence(scope: ActivityIncarnation) {
    this.incarnations.delete(scope);
  }

  public clear() {
    this.incarnations.clear();
    this.unscoped = new ScopeEvidence(this.callsPerLog);
  }
}
