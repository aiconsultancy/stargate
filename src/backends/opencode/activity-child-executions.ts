import type { TurnActivityLog } from "../backend";
import type { ActivityEvent } from "./activity-projector";
import {
  ActivityDeltaWindow,
  ActivitySequenceWindow,
} from "./activity-replay-ledger";
import { boundarySeq, witnessedExecutions } from "./crew-executions";

export type ChildReplayState = {
  cursor?: number;
  sequences?: ActivitySequenceWindow;
  deltaIDs?: ActivityDeltaWindow;
  finished?: true;
};

type Execution = ChildReplayState & {
  log: TurnActivityLog;
  lower?: number;
};

type Start = { seq: number | undefined; order: number };

type History<Child> = {
  writers: number;
  latest?: Child;
  admitted?: true;
  cursor?: number;
  observedStart?: Start;
  blocked?: true;
  messages: Map<string, Child>;
  tombstones: Set<bigint>;
  intervals: { lower: number; end: number; child: Child | null }[];
};

const maxTombstones = 512;

/** A child session can span several independently owned native executions. */
export class ChildExecutions<Child extends Execution> {
  private readonly sessions = new Map<string, History<Child>>();
  private readonly retired = new Map<string, History<Child>>();
  private readonly waitingStarts = new Map<string, Start>();
  private compacted = false;

  public constructor(private readonly limit: number) {}

  public get(id: string) {
    return this.sessions.get(id) ?? this.retired.get(id);
  }

  public mayHaveCompacted(id: string) {
    // A missing entry no longer proves that the collector has never seen this ID.
    return this.compacted && !this.get(id);
  }

  private start(id: string) {
    return this.get(id)?.observedStart ?? this.waitingStarts.get(id);
  }

  public startOrder(id: string) {
    return this.start(id)?.order;
  }

  public needsStart(id: string) {
    const history = this.get(id);

    return (
      history?.admitted === true ||
      history?.observedStart !== undefined ||
      this.waitingStarts.has(id)
    );
  }

  public block(id: string) {
    const history = this.get(id);

    if (history) {
      history.blocked = true;
    }
  }

  private track(id: string) {
    const existing = this.sessions.get(id);

    if (existing) {
      return existing;
    }

    const history: History<Child> = this.retired.get(id) ?? {
      writers: 0,
      messages: new Map(),
      tombstones: new Set(),
      intervals: [],
    };

    this.retired.delete(id);
    const observedStart = this.waitingStarts.get(id);

    if (observedStart !== undefined) {
      history.observedStart = observedStart;
      this.waitingStarts.delete(id);
    }

    this.sessions.set(id, history);

    return history;
  }

  /** An observed start cannot be presented as fresh after a candidate is dropped. */
  public staleStart(id: string, seq: number | undefined, order: number) {
    const history = this.get(id);
    const last = this.start(id)?.seq;

    if (seq !== undefined && last !== undefined && seq <= last) {
      return true;
    }

    const start = { seq: seq ?? last, order };

    if (history) {
      history.observedStart = start;
    } else {
      this.waitingStarts.delete(id);
      this.waitingStarts.set(id, start);

      if (this.waitingStarts.size > this.limit) {
        const oldest = this.waitingStarts.keys().next().value;

        if (oldest !== undefined) {
          this.waitingStarts.delete(oldest);
        }
      }
    }

    return false;
  }

  public settled(id: string, child: Child, seq: number | undefined) {
    const history = this.get(id);

    if (
      history &&
      child.lower !== undefined &&
      seq !== undefined &&
      child.lower < seq
    ) {
      history.intervals.push({ lower: child.lower, end: seq, child });

      if (history.intervals.length > witnessedExecutions) {
        history.intervals.shift();
      }
    }
  }

  public advance(id: string, child: Child, seq: number | undefined) {
    const history = this.get(id);

    if (history && seq !== undefined) {
      history.cursor = Math.max(history.cursor ?? -1, seq);
      child.cursor = Math.max(child.cursor ?? -1, seq);
    }
  }

  public admitted(id: string, child: Child) {
    const history = this.track(id);
    history.writers += 1;
    history.latest = child;
    history.admitted = true;
    delete history.blocked;
    child.log.onEvicted?.(() => {
      this.evict(id, history, child);
    });
  }

  public owner(id: string, message: string, seq: number | undefined) {
    const history = this.get(id);

    const known =
      history?.messages.get(message) ??
      (history?.tombstones.size && history.tombstones.has(Bun.hash(message, 0n))
        ? null
        : undefined);

    return known !== undefined || seq === undefined
      ? known
      : history?.intervals.findLast(
          ({ lower, end }) => lower < seq && seq < end,
        )?.child;
  }

  public remember(id: string, child: Child, message: string) {
    const history = this.get(id);

    if (!history) {
      return;
    }

    if (!history.messages.has(message)) {
      history.messages.set(message, child);
    }
  }

  public record(child: Child, event: ActivityEvent) {
    const seq = boundarySeq(event);

    if (seq !== undefined) {
      child.sequences ??= new ActivitySequenceWindow(child.lower ?? -1);

      return child.sequences.record(seq);
    }

    if (event.type.endsWith(".delta") && typeof event.id === "string") {
      child.deltaIDs ??= new ActivityDeltaWindow(child.finished);

      if (child.deltaIDs.duplicate(event.id)) {
        return "duplicate" as const;
      }
    }

    return "new" as const;
  }

  public finish(child: Child) {
    child.finished = true;

    if (child.deltaIDs) {
      child.deltaIDs = child.deltaIDs.settled();
    }
  }

  public clear() {
    this.sessions.clear();
    this.retired.clear();
    this.waitingStarts.clear();
    this.compacted = false;
  }

  /** Release the writer and its payload immediately when the hub evicts it. */
  private evict(id: string, history: History<Child>, child: Child) {
    if (history.latest === child) {
      delete history.latest;
    }

    for (const [message, owner] of history.messages) {
      if (owner !== child) {
        continue;
      }

      history.messages.delete(message);
      history.tombstones.add(Bun.hash(message, 0n));

      if (history.tombstones.size > maxTombstones) {
        const oldest = history.tombstones.values().next().value;

        if (oldest !== undefined) {
          history.tombstones.delete(oldest);
        }
      }
    }

    for (const interval of history.intervals) {
      if (interval.child === child) {
        interval.child = null;
      }
    }

    history.writers -= 1;

    // Writers follow hub retention. Only writerless routing metadata has its own cap.
    if (history.writers === 0 && this.sessions.get(id) === history) {
      this.sessions.delete(id);
      this.retired.set(id, history);

      if (this.retired.size > this.limit) {
        const oldest = this.retired.keys().next().value;

        if (oldest !== undefined) {
          this.retired.delete(oldest);
          this.compacted = true;
        }
      }
    }
  }
}
