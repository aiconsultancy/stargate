import { Predicate } from "effect";
import type { ActivityOutcome } from "../backend";

/** The frame's position in this session's own durable log, when supplied. */
export function boundarySeq(event: unknown) {
  const durable: unknown = Predicate.hasProperty(event, "durable")
    ? event.durable
    : undefined;

  const session: unknown = Predicate.hasProperty(event, "data")
    ? Predicate.hasProperty(event.data, "sessionID") && event.data.sessionID
    : undefined;

  return Predicate.hasProperty(durable, "seq") &&
    Predicate.hasProperty(durable, "aggregateID") &&
    durable.aggregateID === session &&
    Number.isSafeInteger(durable.seq)
    ? Number(durable.seq)
    : undefined;
}

/** The boundary fence survives reconnects and applies to both starts and ends. */
export function staleBoundary(session: { boundary: number }, seq?: number) {
  if (seq === undefined) {
    return false;
  }

  if (seq <= session.boundary) {
    return true;
  }

  session.boundary = seq;

  return false;
}

/**
 * Settled executions remembered per session. 16 matches the turns the hub
 * keeps per member and the settled tasks the crew report keeps per member:
 * a late message of an older execution has no retained turn to join.
 */
export const witnessedExecutions = 16;

/** A settled execution whose durable bounds were both witnessed. */
export type WitnessedExecution = {
  position: number;
  /** Its own start's sequence, or the previous settlement's. */
  lower: number;
  /** Its settlement's sequence. */
  settled: number;
  outcome: ActivityOutcome;
  lost: true | undefined;
};

/**
 * A session's recently settled executions, by durable sequence, so that a
 * message first seen after its execution settled joins that execution only
 * when its own sequence proves it. Oldest go first past the bound.
 */
export class ExecutionHistory {
  /** Where the running execution began; undefined when never witnessed. */
  private lower: number | undefined;
  private readonly settledExecutions: WitnessedExecution[] = [];

  /** The running execution began at this sequence; unknown without one. */
  public started(seq: number | undefined) {
    this.lower = seq;
  }

  /** The running execution, at `position`, settled at `seq`. */
  public settled(
    position: number,
    seq: number | undefined,
    outcome: ActivityOutcome,
    lost?: true,
  ) {
    if (seq !== undefined && this.lower !== undefined) {
      this.settledExecutions.push({
        position,
        lower: this.lower,
        settled: seq,
        outcome,
        lost,
      });

      if (this.settledExecutions.length > witnessedExecutions) {
        this.settledExecutions.shift();
      }
    }

    // An unsequenced settlement leaves the next execution's start unknown.
    this.lower = seq;
  }

  /**
   * The event stream reattached: boundaries in the gap were not seen, so
   * the running execution's start is unknown. Settled intervals stay.
   */
  public reconnected() {
    this.lower = undefined;
  }

  /** The settled execution whose witnessed bounds hold `seq` strictly. */
  public holding(seq: number | undefined) {
    return this.settledExecutions.findLast(
      (execution) =>
        seq !== undefined && execution.lower < seq && seq < execution.settled,
    );
  }
}
