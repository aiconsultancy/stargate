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
  parent: TurnActivityLog;
  log: TurnActivityLog;
  lower?: number;
};

type Start = { seq: number | undefined; order: number };

type History<Child> = {
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
  private readonly waitingStarts = new Map<string, Start>();

  public constructor(private readonly limit: number) {}

  public get(id: string) {
    return this.sessions.get(id);
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

  public track(id: string) {
    const existing = this.get(id);

    if (existing) {
      return existing;
    }

    if (this.sessions.size >= this.limit) {
      for (const [key, history] of this.sessions) {
        if (
          (!history.latest || history.latest.parent.retained?.() === false) &&
          [...history.messages.values()].every(
            (child) => child.parent.retained?.() === false,
          ) &&
          history.intervals.every(
            ({ child }) =>
              child === null || child.parent.retained?.() === false,
          )
        ) {
          this.sessions.delete(key);

          break;
        }
      }
    }

    if (this.sessions.size >= this.limit) {
      return;
    }

    const history: History<Child> = {
      messages: new Map(),
      tombstones: new Set(),
      intervals: [],
    };

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
    const history = this.get(id);

    if (history) {
      history.latest = child;
      history.admitted = true;
      delete history.blocked;
      child.log.onEvicted?.(() => {
        this.evict(history, child);
      });
    }
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
    this.waitingStarts.clear();
  }

  /** Release the writer and its payload immediately when the hub evicts it. */
  private evict(history: History<Child>, child: Child) {
    if (history.latest === child) {
      delete history.latest;
    }

    for (const [id, owner] of history.messages) {
      if (owner !== child) {
        continue;
      }

      history.messages.delete(id);
      history.tombstones.add(Bun.hash(id, 0n));

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
  }
}
